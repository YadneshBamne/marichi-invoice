import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { account, businesses, buyerSellerRelationships, invoiceConfirmations, invoices, memberships, notifications, tickets, users } from "../db/schema";
import { gw as baseGw, world } from "../testkit";
import { createInvoice } from "../invoices/service";
import { linkBuyer } from "../relationships/service";
import { mock } from "../integrations/mock";
import { sendForConfirmation } from "./service";
import { claimAccount, decideByLink, LINK, requestCode, tokenFor, viewByToken } from "./link";
import { ACCEPTANCE_VERSION } from "./wording";

let w: Awaited<ReturnType<typeof world>>;
const T = new Date("2026-10-06T00:00:00Z");
const min = (m: number) => new Date(T.getTime() + m * 60_000);
const hash = async (p: string) => `h:${p}`;
const mail: { to: string; template: string; body: string; subject?: string }[] = [];
const gw = { ...baseGw, notify: { send: async (p: { to: string; template: string; body: string; subject?: string }) => { mail.push(p); } } } as never;
const last = (template: string, to?: string) => [...mail].reverse().find((m) => m.template === template && (!to || m.to === to));
const codeFor = (to: string) => /\b(\d{6})\b/.exec(last("confirmation_code", to)!.body)![1];
let n = 0;

/** A supplier names a buyer that has no account and raises an invoice on it. */
async function pendingBuyerInvoice(contact = "ap@newbuyer.com") {
  const gstin = `29NEWBY${String(1000 + ++n)}N1Z5`;
  await linkBuyer(w.db, { sellerId: w.sellerId, buyerGstin: gstin, buyerEmail: contact, buyerName: "New Buyer Pvt Ltd" });
  const [b] = await w.db.select().from(businesses).where(eq(businesses.gstin, gstin));
  const inv = await createInvoice(w.db, { sellerId: w.sellerId, buyerId: b.id, invoiceNumber: `LK-${n}`, invoiceDate: "2026-09-25", dueDate: "2026-12-01", amount: 5_00_000_00n, contentHash: `lk${n}` }, mock, T);
  mail.length = 0;
  expect(await sendForConfirmation(w.db, inv.id, gw, T)).toBe(true);
  const token = (await w.db.select().from(invoiceConfirmations).where(eq(invoiceConfirmations.invoiceId, inv.id)))[0].token!;
  return { buyer: b, invoiceId: inv.id, token, contact };
}
const status = async (id: string) => (await w.db.select().from(invoices).where(eq(invoices.id, id)))[0].status;
const conf = async (id: string) => (await w.db.select().from(invoiceConfirmations).where(eq(invoiceConfirmations.invoiceId, id)))[0];
async function verified(f: { token: string; contact: string }, at = T) {
  await requestCode(w.db, f.token, f.contact, gw, at);
  return codeFor(f.contact);
}

beforeEach(async () => { w = await world(); mail.length = 0; });

describe("the emailed link", () => {
  it("the buyer's contact gets the email with a link, though they have no account; the token is stored hashed and reusable", async () => {
    const f = await pendingBuyerInvoice();
    const m = last("confirmation_requested", f.contact)!;
    expect(m.body).toContain(`/confirm/${f.token}`);
    expect((await conf(f.invoiceId)).tokenHash).not.toContain(f.token);
    expect(await tokenFor(w.db, f.invoiceId)).toBe(f.token); // reminders reuse the same link
  });

  it("a buyer who has accounts gets it in their inbox and is not emailed twice", async () => {
    const [inv] = await (async () => { const o = await w.offered(); return [o]; })();
    void inv;
    await w.db.update(buyerSellerRelationships).set({ contactEmail: "ap@big.com" }).where(eq(buyerSellerRelationships.buyerId, w.buyerId));
    const created = await createInvoice(w.db, { sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: "LK-REG", invoiceDate: "2026-09-25", dueDate: "2026-12-01", amount: 5_00_000_00n, contentHash: "lkreg" }, mock, T);
    mail.length = 0;
    await sendForConfirmation(w.db, created.id, gw, T);
    expect(mail.filter((m) => m.template === "confirmation_requested" && m.to === "ap@big.com")).toHaveLength(1);
    expect((await w.db.select().from(notifications).where(eq(notifications.template, "confirmation_requested"))).length).toBeGreaterThan(0);
  });

  it("nobody to send to goes to staff instead of waiting forever", async () => {
    const f = await pendingBuyerInvoice();
    await w.db.update(buyerSellerRelationships).set({ contactEmail: null }).where(eq(buyerSellerRelationships.buyerId, f.buyer.id));
    await w.db.update(invoices).set({ status: "validated" }).where(eq(invoices.id, f.invoiceId));
    await w.db.delete(invoiceConfirmations).where(eq(invoiceConfirmations.invoiceId, f.invoiceId));
    await w.db.insert(users).values({ name: "Ops", email: "ops@m.com", role: "ops" });
    mail.length = 0;
    await sendForConfirmation(w.db, f.invoiceId, gw, T);
    expect(last("confirmation_undeliverable", "ops@m.com")).toBeTruthy();
  });

  it("shows the invoice and the exact wording; an unknown link shows nothing", async () => {
    const f = await pendingBuyerInvoice();
    const v = await viewByToken(w.db, f.token, T);
    if (v.state !== "open") throw new Error("expected open");
    expect(v.invoice).toMatchObject({ seller: "Seller Co", buyer: "New Buyer Pvt Ltd", number: `LK-${n}` });
    expect(v.wording.join(" ")).toContain("without set-off, counterclaim or deduction");
    expect(v.wording.join(" ")).toContain("waives any restriction on assignment");
    expect(await viewByToken(w.db, "nonsense-token-nonsense-token", T)).toEqual({ state: "unknown" });
  });
});

describe("the one-time code", () => {
  it("is emailed only to an address on file; any other address gets the same reply and nothing is sent", async () => {
    const f = await pendingBuyerInvoice();
    mail.length = 0;
    expect(await requestCode(w.db, f.token, "stranger@elsewhere.com", gw, T)).toEqual({ sent: true });
    expect(mail).toHaveLength(0);
    await requestCode(w.db, f.token, " AP@NewBuyer.com ", gw, T);
    expect(last("confirmation_code", f.contact)).toBeTruthy();
    expect(codeFor(f.contact)).toMatch(/^\d{6}$/);
  });

  it("cannot be asked for again within a minute", async () => {
    const f = await pendingBuyerInvoice();
    await requestCode(w.db, f.token, f.contact, gw, T);
    await expect(requestCode(w.db, f.token, f.contact, gw, new Date(T.getTime() + 30_000))).rejects.toThrow(/wait a minute/);
    await requestCode(w.db, f.token, f.contact, gw, new Date(T.getTime() + 61_000));
  });

  it("is stored only as a hash", async () => {
    const f = await pendingBuyerInvoice();
    const code = await verified(f);
    expect((await conf(f.invoiceId)).otpHash).not.toContain(code);
  });

  it("five wrong tries lock it; a new code starts again", async () => {
    const f = await pendingBuyerInvoice();
    const code = await verified(f);
    for (let i = 0; i < LINK.maxAttempts; i++) await expect(decideByLink(w.db, f.token, { email: f.contact, code: "000000", decision: "confirm" }, gw, T)).rejects.toThrow(/not right/);
    await expect(decideByLink(w.db, f.token, { email: f.contact, code, decision: "confirm" }, gw, T)).rejects.toThrow(/too many/);
    await requestCode(w.db, f.token, f.contact, gw, min(5));
    const fresh = codeFor(f.contact);
    expect((await decideByLink(w.db, f.token, { email: f.contact, code: fresh, decision: "confirm" }, gw, min(6))).status).toBe("eligible");
  });

  it("expires after ten minutes, is tied to the address, and is spent once used", async () => {
    const f = await pendingBuyerInvoice();
    const code = await verified(f);
    await expect(decideByLink(w.db, f.token, { email: f.contact, code, decision: "confirm" }, gw, min(LINK.codeMinutes + 1))).rejects.toThrow(/new code/);
    await expect(decideByLink(w.db, f.token, { email: "other@x.com", code, decision: "confirm" }, gw, min(2))).rejects.toThrow(/new code/);
    await decideByLink(w.db, f.token, { email: f.contact, code, decision: "confirm" }, gw, min(2));
    await expect(decideByLink(w.db, f.token, { email: f.contact, code, decision: "confirm" }, gw, min(3))).rejects.toThrow(/new code/);
  });
});

describe("answering from the link", () => {
  it("confirm: the invoice becomes eligible, the wording and verified address are the legal record, and the buyer is lightly verified", async () => {
    const f = await pendingBuyerInvoice();
    const code = await verified(f);
    const r = await decideByLink(w.db, f.token, { email: f.contact, code, decision: "confirm", ip: "9.9.9.9", userAgent: "vitest" }, gw, min(1));
    expect(r.status).toBe("eligible");
    expect(await status(f.invoiceId)).toBe("eligible");
    const c = await conf(f.invoiceId);
    expect(c).toMatchObject({ status: "confirmed", method: "link", respondedBy: null, respondedByEmail: f.contact, verifiedEmail: f.contact, ip: "9.9.9.9", acceptanceVersion: ACCEPTANCE_VERSION });
    expect(c.acceptanceText).toContain("New Buyer Pvt Ltd");
    expect(c.acceptanceText).toContain("Seller Co");
    expect(c.acceptanceText).toContain("without set-off, counterclaim or deduction");
    expect(c.claimUntil).not.toBeNull();
    expect((await w.db.select().from(businesses).where(eq(businesses.id, f.buyer.id)))[0].kybStatus).toBe("approved");
    expect(await w.db.select().from(notifications).where(eq(notifications.template, "invoice_confirmed"))).not.toHaveLength(0); // the seller is told
  });

  it("only one answer: a second attempt on the same link is refused", async () => {
    const f = await pendingBuyerInvoice();
    await decideByLink(w.db, f.token, { email: f.contact, code: await verified(f), decision: "confirm" }, gw, min(1));
    await requestCode(w.db, f.token, f.contact, gw, min(5)).catch(() => {});
    await expect(requestCode(w.db, f.token, f.contact, gw, min(5))).rejects.toThrow(/no longer open/);
    expect((await viewByToken(w.db, f.token, min(5))).state).toBe("answered");
  });

  it("dispute needs a reason, pauses the invoice and opens a ticket; it does not verify the buyer", async () => {
    const f = await pendingBuyerInvoice();
    const code = await verified(f);
    await expect(decideByLink(w.db, f.token, { email: f.contact, code, decision: "dispute", note: " " }, gw, min(1))).rejects.toThrow(/note is required/);
    await requestCode(w.db, f.token, f.contact, gw, min(3));
    const r = await decideByLink(w.db, f.token, { email: f.contact, code: codeFor(f.contact), decision: "dispute", note: "goods never arrived" }, gw, min(4));
    expect(r.status).toBe("disputed");
    expect(await status(f.invoiceId)).toBe("disputed");
    expect((await w.db.select().from(tickets)).some((t) => t.kind === "dispute")).toBe(true);
    expect((await conf(f.invoiceId)).acceptanceText).toBeNull();
    expect((await w.db.select().from(businesses).where(eq(businesses.id, f.buyer.id)))[0].kybStatus).toBe("submitted");
    expect((await conf(f.invoiceId)).claimUntil).toBeNull();
  });

  it("a question keeps the invoice open for a later confirm", async () => {
    const f = await pendingBuyerInvoice();
    await decideByLink(w.db, f.token, { email: f.contact, code: await verified(f), decision: "clarify", note: "which PO?" }, gw, min(1));
    expect(await status(f.invoiceId)).toBe("sent_for_confirmation");
  });

  it("an expired link cannot be used even with a valid code", async () => {
    const f = await pendingBuyerInvoice();
    const code = await verified(f);
    const late = new Date(T.getTime() + (LINK.tokenDays + 1) * 86_400_000);
    await expect(decideByLink(w.db, f.token, { email: f.contact, code, decision: "confirm" }, gw, late)).rejects.toThrow(/new code|expired/);
    expect((await viewByToken(w.db, f.token, late)).state).toBe("expired");
  });

  it("a signed-in buyer user's own confirmation records the same legal wording", async () => {
    const { respondToInvoice } = await import("./service");
    const created = await createInvoice(w.db, { sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: "LK-APP", invoiceDate: "2026-09-25", dueDate: "2026-12-01", amount: 5_00_000_00n, contentHash: "lkapp" }, mock, T);
    await sendForConfirmation(w.db, created.id, gw, T);
    await respondToInvoice(w.db, { invoiceId: created.id, actor: { id: w.buyerUserId, email: "ap@big.com", role: "buyer", businessId: w.buyerId }, decision: "confirm" }, gw, T);
    const c = await conf(created.id);
    expect(c).toMatchObject({ method: "buyer", acceptanceVersion: ACCEPTANCE_VERSION });
    expect(c.acceptanceText).toContain("Big Corp");
    expect(c.claimUntil).toBeNull(); // a company with users has nothing to claim
  });
});

describe("creating the account afterwards", () => {
  async function confirmed() {
    const f = await pendingBuyerInvoice();
    await decideByLink(w.db, f.token, { email: f.contact, code: await verified(f), decision: "confirm" }, gw, min(1));
    return f;
  }
  it("the verified address can create the company's account within the hour and becomes its owner", async () => {
    const f = await confirmed();
    const r = await claimAccount(w.db, hash, f.token, { name: "Priya Buyer", password: "a-long-enough-pass" }, min(10));
    expect(r.email).toBe(f.contact);
    const [u] = await w.db.select().from(users).where(eq(users.id, r.userId));
    expect(u).toMatchObject({ role: "buyer", businessId: f.buyer.id, orgRole: "owner", emailVerified: true, twoFactorEnabled: false });
    expect((await w.db.select().from(account).where(eq(account.userId, u.id)))[0].password).toBe("h:a-long-enough-pass");
    expect((await w.db.select().from(memberships).where(and(eq(memberships.userId, u.id), eq(memberships.businessId, f.buyer.id))))[0].orgRole).toBe("owner");
    await expect(claimAccount(w.db, hash, f.token, { name: "Someone Else", password: "a-long-enough-pass" }, min(11))).rejects.toThrow(/ended/); // once only
  });
  it("is refused after the hour, for a weak password, or if the company already has an owner", async () => {
    const f = await confirmed();
    await expect(claimAccount(w.db, hash, f.token, { name: "Priya Buyer", password: "short" }, min(10))).rejects.toThrow(/10 characters/);
    await expect(claimAccount(w.db, hash, f.token, { name: "Priya Buyer", password: "a-long-enough-pass" }, min(90))).rejects.toThrow(/ended/);
    const g = await confirmed();
    await w.db.insert(users).values({ name: "Owner", email: "owner@new.com", role: "buyer", businessId: g.buyer.id, orgRole: "owner" });
    const [o] = await w.db.select().from(users).where(eq(users.email, "owner@new.com"));
    await w.db.insert(memberships).values({ userId: o.id, businessId: g.buyer.id, orgRole: "owner" });
    await expect(claimAccount(w.db, hash, g.token, { name: "Priya Buyer", password: "a-long-enough-pass" }, min(10))).rejects.toThrow(/already has an account/);
  });
  it("an answer that is not a confirmation offers no account", async () => {
    const f = await pendingBuyerInvoice();
    await decideByLink(w.db, f.token, { email: f.contact, code: await verified(f), decision: "dispute", note: "wrong amount" }, gw, min(1));
    await expect(claimAccount(w.db, hash, f.token, { name: "Priya Buyer", password: "a-long-enough-pass" }, min(10))).rejects.toThrow(/ended/);
  });
});
