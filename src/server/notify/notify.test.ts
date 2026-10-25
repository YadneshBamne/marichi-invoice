import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, notifications, phoneOtps, pushSubscriptions, users } from "../db/schema";
import { testDb } from "../testdb";
import { mock } from "../integrations/mock";
import type { Database } from "../db/client";
import { channelsFor, deliverQueued, getPreferences, MAX_ATTEMPTS, notifyBusiness, notifyStaff, recordDeliveryReceipt, setPreference } from "./index";
import { requestPhoneOtp, verifyPhoneOtp } from "./phone";
import { placeholders, render, TEMPLATES } from "./templates";

const T0 = new Date("2026-10-06T10:00:00Z");
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
let db: Database, bizId: string, userId: string;

type Call = { channel: string; to: string; template: string; subject?: string; body: string; dltTemplateId?: string };
let calls: Call[] = [];
let failNext = 0; // how many sends should throw
const gw = { ...mock, notify: { send: async (p: Call) => {
  if (failNext > 0) { failNext--; throw new Error("provider 503"); }
  calls.push(p);
  return { providerRef: `REF-${calls.length}` };
} } };

beforeEach(async () => {
  calls = []; failNext = 0;
  db = await testDb();
  bizId = (await db.insert(businesses).values({ legalName: "Seller Co", entityType: "pvt_ltd" }).returning())[0].id;
  userId = (await db.insert(users).values({ name: "S", email: "s@seller.com", role: "seller", businessId: bizId, phone: "+919876543210", phoneVerified: true }).returning())[0].id;
});
const rows = () => db.select().from(notifications);
const data = { invoiceNumber: "INV-1", amount: "₹5,000.00", due: "2026-11-20", dpd: "6", note: "x" };

describe("template registry", () => {
  it("every placeholder is a declared field", () => {
    for (const [key, t] of Object.entries(TEMPLATES)) {
      const used = [...placeholders(t.email.subject), ...placeholders(t.email.body), ...(t.sms ? placeholders(t.sms.text) : []),
        ...(t.push ? [...placeholders(t.push.title), ...placeholders(t.push.body), ...placeholders(t.push.url ?? "")] : []), ...(t.whatsapp?.params ?? [])];
      for (const f of used) expect(t.fields, `${key} uses {{${f}}}`).toContain(f);
    }
  });
  it("WhatsApp and push are rendered for the templates that have them: parameters in order as JSON, title and link for push", () => {
    const d = { ...data, noticeNo: "LN-1", cureBy: "2026-11-30", link: "https://app.example.com/n/1", advance: "₹4,000.00", expires: "2026-10-30" };
    expect(JSON.parse(render("disbursed", "whatsapp", d)!.body)).toEqual(["₹5,000.00", "INV-1"]);
    expect(JSON.parse(render("disbursed", "whatsapp", { ...d, amount: "" })!.body)).toEqual(["-", "INV-1"]); // WhatsApp refuses empty values
    expect(TEMPLATES.legal_notice.whatsapp!.template).toBe("marichi_legal_notice");
    const p = render("legal_notice", "push", { ...d, noticeNo: "LN-1\nx" })!;
    expect(p).toMatchObject({ subject: "Legal notice LN-1 x" });
    expect(JSON.parse(p.body)).toEqual({ body: "Invoice INV-1: pay ₹5,000.00 by 2026-11-30.", url: "https://app.example.com/n/1" });
    expect(render("payment_received", "whatsapp", d)).toBeNull();
    expect(render("payment_received", "push", d)).toBeNull();
  });
  it("SMS stays GSM-7 safe and short even with ₹ amounts", () => {
    for (const [key, t] of Object.entries(TEMPLATES)) {
      if (!t.sms) continue;
      const body = render(key, "sms", { ...data, link: "", caseId: "" })!.body;
      expect(body, key).toMatch(/^[\x20-\x7E]*$/);
      expect(body.length, key).toBeLessThanOrEqual(160);
    }
  });
  it("flattens newlines in user-controlled values for subjects and SMS, rejects unknown templates", () => {
    expect(render("invoice_disputed", "email", { ...data, invoiceNumber: "A\r\nBcc: evil@x.com" })!.subject).toBe("Invoice A Bcc: evil@x.com was disputed");
    expect(() => render("nope", "email", {})).toThrow(/unknown/);
    expect(render("payment_received", "sms", data)).toBeNull(); // no SMS variant
  });
});

describe("channel choice", () => {
  const u = (over = {}) => ({ id: "x", email: "e", phone: "+919876543210", phoneVerified: true, ...over });
  it("critical => every channel the user has; non-critical respects opt-outs", () => {
    expect(channelsFor("disbursed", u(), new Set())).toEqual(["email", "sms"]);
    expect(channelsFor("disbursed", u(), new Set(["email", "sms"]))).toEqual(["email", "sms"]); // opt-out can't silence critical
    expect(channelsFor("offer_ready", u(), new Set())).toEqual(["email"]); // no SMS variant
    expect(channelsFor("offer_ready", u(), new Set(["email"]))).toEqual([]);
    expect(channelsFor("disbursed", u({ phoneVerified: false }), new Set())).toEqual(["email"]); // unverified number never gets SMS
    expect(channelsFor("disbursed", u({ phone: null }), new Set())).toEqual(["email"]);
  });
  it("WhatsApp needs a verified number, a template that has it and an explicit opt-in (even when critical)", () => {
    const yes = { optedIn: new Set(["whatsapp"]) };
    expect(channelsFor("disbursed", u(), new Set())).toEqual(["email", "sms"]); // no opt-in: off
    expect(channelsFor("disbursed", u(), new Set(), yes)).toEqual(["email", "sms", "whatsapp"]);
    expect(channelsFor("disbursed", u({ phoneVerified: false }), new Set(), yes)).toEqual(["email"]);
    expect(channelsFor("disbursed", u({ phone: null }), new Set(), yes)).toEqual(["email"]);
    expect(channelsFor("disbursed", u(), new Set(["whatsapp"]), { optedIn: new Set() })).toEqual(["email", "sms"]); // opted out is off
    expect(channelsFor("payment_received", u(), new Set(), yes)).toEqual(["email"]); // template has no WhatsApp text
    expect(channelsFor("offer_ready", u(), new Set(["email"]), yes)).toEqual(["whatsapp"]); // opt-in is independent of the email opt-out
  });
  it("push needs a subscription and a template with push text; only a non-critical template respects a push opt-out", () => {
    const sub = { hasPush: true };
    expect(channelsFor("disbursed", u(), new Set(), sub)).toEqual(["email", "sms", "push"]);
    expect(channelsFor("disbursed", u({ phone: null }), new Set(["push"]), sub)).toEqual(["email", "push"]); // critical ignores the opt-out
    expect(channelsFor("disbursed", u(), new Set(), { hasPush: false })).toEqual(["email", "sms"]);
    expect(channelsFor("payment_received", u(), new Set(), sub)).toEqual(["email"]); // no push text
    expect(channelsFor("offer_ready", u(), new Set(), sub)).toEqual(["email", "push"]);
    expect(channelsFor("offer_ready", u(), new Set(["push"]), sub)).toEqual(["email"]);
    expect(channelsFor("disbursed", u(), new Set(), { hasPush: true, optedIn: new Set(["whatsapp"]) })).toEqual(["email", "sms", "whatsapp", "push"]);
  });
});

describe("notifyBusiness", () => {
  it("critical message: email + SMS with DLT id and absolute links; rows are logged", async () => {
    process.env.BETTER_AUTH_URL = "https://app.example.com/";
    try {
      await notifyBusiness(db, bizId, "assignment_notice", { invoiceNumber: "INV-1", link: "/api/documents/abc.html" }, gw, T0);
    } finally { delete process.env.BETTER_AUTH_URL; }
    expect(calls.map((c) => c.channel)).toEqual(["email", "sms"]);
    expect(calls[0].body).toContain("https://app.example.com/api/documents/abc.html");
    expect(calls[1]).toMatchObject({ to: "+919876543210", dltTemplateId: expect.stringContaining("DLT") });
    expect((await rows()).map((r) => `${r.channel}:${r.status}`).sort()).toEqual(["email:sent", "sms:sent"]);
    expect((await rows())[0].providerRef).toMatch(/^REF-/);
  });

  it("non-critical: email only; opted-out user gets nothing; critical ignores the opt-out", async () => {
    await notifyBusiness(db, bizId, "payment_received", data, gw, T0);
    expect(calls.map((c) => c.channel)).toEqual(["email"]);
    await setPreference(db, userId, "email", false);
    calls = [];
    expect(await notifyBusiness(db, bizId, "payment_received", data, gw, T0)).toBe(0);
    expect(calls).toHaveLength(0);
    await notifyBusiness(db, bizId, "disbursed", data, gw, T0);
    expect(calls.map((c) => c.channel)).toEqual(["email", "sms"]);
    expect(await getPreferences(db, userId)).toEqual({ email: false, sms: true, whatsapp: false });
  });

  it("WhatsApp goes out only after an opt-in; push makes one row per subscribed browser with the endpoint as address", async () => {
    await db.insert(pushSubscriptions).values([
      { userId, endpoint: "https://fcm.googleapis.com/fcm/send/one", p256dh: "k1", auth: "a1" },
      { userId, endpoint: "https://fcm.googleapis.com/fcm/send/two", p256dh: "k2", auth: "a2" },
    ]);
    await notifyBusiness(db, bizId, "disbursed", data, gw, T0);
    expect(calls.map((c) => c.channel)).toEqual(["email", "sms", "push", "push"]);
    const push = calls.filter((c) => c.channel === "push");
    expect(push.map((c) => c.to)).toEqual(["https://fcm.googleapis.com/fcm/send/one", "https://fcm.googleapis.com/fcm/send/two"]);
    expect(push[0]).toMatchObject({ subject: "Payout sent", dltTemplateId: undefined });
    expect(JSON.parse(push[0].body)).toEqual({ body: "₹5,000.00 was paid to your bank account for invoice INV-1.", url: "/notifications" });
    expect(JSON.stringify(await rows())).not.toContain("p256dh"); // keys never copied into the outbox

    calls = [];
    await setPreference(db, userId, "whatsapp", true);
    expect(await getPreferences(db, userId)).toMatchObject({ whatsapp: true });
    await notifyBusiness(db, bizId, "disbursed", data, gw, T0);
    const wa = calls.find((c) => c.channel === "whatsapp")!;
    expect(wa).toMatchObject({ to: "+919876543210", template: "disbursed", dltTemplateId: undefined });
    expect(JSON.parse(wa.body)).toEqual(["₹5,000.00", "INV-1"]);
  });

  it("an error marked permanent is not retried", async () => {
    const dead = { ...mock, notify: { send: async () => { throw Object.assign(new Error("subscription expired (410)"), { permanent: true }); } } };
    await db.insert(pushSubscriptions).values({ userId, endpoint: "https://fcm.googleapis.com/fcm/send/gone", p256dh: "k", auth: "a" });
    await notifyBusiness(db, bizId, "disbursed", data, dead, T0);
    const pushRow = (await rows()).find((r) => r.channel === "push")!;
    expect(pushRow).toMatchObject({ status: "failed", attempts: 1, error: "subscription expired (410)", toAddress: "https://fcm.googleapis.com/fcm/send/gone" });
    expect(await deliverQueued(db, gw, min(100_000))).toBe(0);
  });

  it("notifyStaff reaches only the given roles", async () => {
    await db.insert(users).values([{ name: "O", email: "ops@m.com", role: "ops" }, { name: "A", email: "adm@m.com", role: "admin" }]);
    await notifyStaff(db, ["ops"], "unmatched_credit", { utr: "U1", reason: "x" }, gw, T0);
    expect(calls.map((c) => c.to)).toEqual(["ops@m.com"]);
  });

  it("an unknown template is a programming error, not a silent drop", async () => {
    await expect(notifyBusiness(db, bizId, "typo_template", {}, gw, T0)).rejects.toThrow(/unknown/);
  });
});

describe("retry with backoff", () => {
  it("failed send stays queued, retries when due, then succeeds; no early retry", async () => {
    failNext = 1;
    await notifyBusiness(db, bizId, "payment_received", data, gw, T0);
    let [r] = await rows();
    expect(r).toMatchObject({ status: "queued", attempts: 1, error: "provider 503" });
    expect(r.nextAttemptAt.getTime()).toBe(min(1).getTime());
    expect(await deliverQueued(db, gw, min(0.5))).toBe(0); // not due
    expect(await deliverQueued(db, gw, min(1))).toBe(1);
    [r] = await rows();
    expect(r).toMatchObject({ status: "sent", error: null });
    expect(await deliverQueued(db, gw, min(5))).toBe(0); // nothing left; never double-sent
    expect(calls).toHaveLength(1);
  });

  it("backs off exponentially and gives up after the max attempts", async () => {
    failNext = 99;
    await notifyBusiness(db, bizId, "payment_received", data, gw, T0);
    const waits: number[] = [];
    let now = T0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const [r] = await rows();
      waits.push((r.nextAttemptAt.getTime() - now.getTime()) / 60_000);
      now = r.nextAttemptAt;
      await deliverQueued(db, gw, now);
    }
    expect(waits).toEqual([1, 5, 30, 120]);
    expect((await rows())[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(await deliverQueued(db, gw, min(100_000))).toBe(0);
  });

  it("one channel failing doesn't block the other", async () => {
    failNext = 1; // email attempt fails, SMS goes through
    await notifyBusiness(db, bizId, "disbursed", data, gw, T0);
    expect((await rows()).map((r) => `${r.channel}:${r.status}`).sort()).toEqual(["email:queued", "sms:sent"]);
  });

  it("recovers a row orphaned in `sending` by a crashed worker", async () => {
    await notifyBusiness(db, bizId, "payment_received", data, gw, T0);
    await db.update(notifications).set({ status: "sending", claimedAt: T0 });
    expect(await deliverQueued(db, gw, min(5))).toBe(0); // worker may still be mid-send
    expect(await deliverQueued(db, gw, min(11))).toBe(1);
  });
});

describe("delivery receipts", () => {
  it("sent -> delivered -> read, monotonic and idempotent; provider failure after send marks failed", async () => {
    await notifyBusiness(db, bizId, "payment_received", data, gw, T0);
    const ref = (await rows())[0].providerRef!;
    await recordDeliveryReceipt(db, { providerRef: ref, status: "read", at: min(2) });
    await recordDeliveryReceipt(db, { providerRef: ref, status: "delivered", at: min(3) }); // late, must not downgrade
    expect((await rows())[0]).toMatchObject({ status: "read" });
    expect((await rows())[0].deliveredAt).toBeTruthy();
    await expect(recordDeliveryReceipt(db, { providerRef: "nope", status: "delivered" })).rejects.toThrow(/unknown/);

    await notifyBusiness(db, bizId, "invoice_settled", data, gw, T0);
    const second = (await rows()).find((r) => r.template === "invoice_settled")!;
    await recordDeliveryReceipt(db, { providerRef: second.providerRef!, status: "failed" });
    expect((await db.select().from(notifications).where(eq(notifications.id, second.id)))[0].status).toBe("failed");
  });
});

describe("phone verification", () => {
  const sms = () => calls.filter((c) => c.channel === "sms");
  const lastCode = () => /(\d{6})/.exec(sms().at(-1)!.body)![1];
  beforeEach(async () => { await db.update(users).set({ phone: null, phoneVerified: false }); });

  it("request -> verify marks the number verified; code is never stored or logged", async () => {
    await requestPhoneOtp(db, userId, "+919811111111", gw, T0);
    expect(sms()[0]).toMatchObject({ to: "+919811111111", dltTemplateId: expect.any(String) });
    expect((await db.select().from(users))[0]).toMatchObject({ phone: "+919811111111", phoneVerified: false });
    const code = lastCode();
    const [otp] = await db.select().from(phoneOtps);
    expect(JSON.stringify(otp)).not.toContain(code);
    expect(await rows()).toHaveLength(0); // nothing in the notifications log
    await verifyPhoneOtp(db, userId, code, min(2));
    expect((await db.select().from(users))[0]).toMatchObject({ phoneVerified: true });
    expect(await db.select().from(phoneOtps)).toHaveLength(0);
  });

  it("wrong codes lock out after 5; expiry; bad format; hourly rate limit; number change un-verifies", async () => {
    await expect(requestPhoneOtp(db, userId, "98765", gw, T0)).rejects.toThrow(/international/);
    await requestPhoneOtp(db, userId, "+919811111111", gw, T0);
    const code = lastCode();
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await expect(verifyPhoneOtp(db, userId, wrong, min(1))).rejects.toThrow("incorrect code");
    await expect(verifyPhoneOtp(db, userId, code, min(1))).rejects.toThrow(/too many wrong/); // even the right code is refused now
    await requestPhoneOtp(db, userId, "+919811111111", gw, min(2)); // fresh code resets guesses
    await expect(verifyPhoneOtp(db, userId, lastCode(), min(13))).rejects.toThrow(/expired/); // 11 min after issue

    await requestPhoneOtp(db, userId, "+919811111111", gw, min(14)); // 3rd request in the hour
    await expect(requestPhoneOtp(db, userId, "+919811111111", gw, min(15))).rejects.toThrow(/too many codes/);
    await requestPhoneOtp(db, userId, "+919811111111", gw, min(75)); // new hour
    await verifyPhoneOtp(db, userId, lastCode(), min(76));
    await requestPhoneOtp(db, userId, "+919822222222", gw, min(200));
    expect((await db.select().from(users))[0]).toMatchObject({ phone: "+919822222222", phoneVerified: false });
  });
});
