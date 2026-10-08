import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { invoiceCollections, invoices, mandates, nachDebits, notifications } from "../db/schema";
import { gw as baseGw, world } from "../testkit";
import { applyDebitResult, applyMandateStatus, presentDebits, registerMandate, revokeMandate, sendPreDebitNotices } from "./nach";
import type { Adapters } from "../integrations/gateway";

let w: Awaited<ReturnType<typeof world>>;
let buyer: { id: string; role: string; businessId: string | null };
const DUE = new Date("2026-11-20T09:00:00Z"); // testkit invoices fall due on 2026-11-20
const day = (n: number) => new Date(DUE.getTime() + n * 86_400_000);
const bank = { accountNumber: "50100123456789", ifsc: "HDFC0001234", holderName: "Big Corp", maxAmount: 20_00_000_00n };

beforeEach(async () => { w = await world(); buyer = { id: w.buyerUserId, role: "buyer", businessId: w.buyerId }; });
const templates = async () => (await w.db.select().from(notifications)).map((n) => n.template);
const activeMandate = async (gw: Adapters = baseGw) => {
  const m = await registerMandate(w.db, buyer, bank, gw);
  await applyMandateStatus(w.db, m.providerRef!, "active", undefined, gw);
  return m;
};
const failingGw = (): Adapters => ({ ...baseGw, mandates: { ...baseGw.mandates, debit: async (p) => ({ debitRef: `D-${p.idempotencyKey}`, status: "failed" as const, reason: "insufficient funds" }) } });

describe("mandate set-up", () => {
  it("registers pending, goes active on the bank's answer, stores the account encrypted, and replays are harmless", async () => {
    const m = await registerMandate(w.db, buyer, bank, baseGw);
    expect(m).toMatchObject({ status: "pending", businessId: w.buyerId });
    const raw = (await w.db.execute(sql`select account_number from mandates`)).rows[0] as { account_number: string };
    expect(raw.account_number.startsWith("enc:v1:")).toBe(true);
    const a = await applyMandateStatus(w.db, m.providerRef!, "active", undefined, baseGw);
    await applyMandateStatus(w.db, m.providerRef!, "rejected", "late webhook", baseGw); // a replay or contradiction after the decision does nothing
    expect(a.status).toBe("active");
    expect((await w.db.select().from(mandates))[0].status).toBe("active");
    expect((await templates()).filter((t) => t === "mandate_active")).toHaveLength(1);
  });

  it("validates, allows one open mandate, and only buyers can register", async () => {
    await expect(registerMandate(w.db, { ...buyer, role: "seller" }, bank, baseGw)).rejects.toThrow(/only a buyer/);
    await expect(registerMandate(w.db, buyer, { ...bank, accountNumber: "12" }, baseGw)).rejects.toThrow(/account number/);
    await expect(registerMandate(w.db, buyer, { ...bank, ifsc: "BAD" }, baseGw)).rejects.toThrow(/IFSC/);
    await expect(registerMandate(w.db, buyer, { ...bank, maxAmount: 0n }, baseGw)).rejects.toThrow(/limit/);
    await registerMandate(w.db, buyer, bank, baseGw);
    await expect(registerMandate(w.db, buyer, bank, baseGw)).rejects.toThrow(/already/);
  });

  it("revoking stops it, and nobody else can revoke it", async () => {
    const m = await activeMandate();
    await expect(revokeMandate(w.db, { ...buyer, businessId: w.sellerId }, m.id, baseGw)).rejects.toThrow("FORBIDDEN");
    await revokeMandate(w.db, buyer, m.id, baseGw);
    expect((await w.db.select().from(mandates))[0].status).toBe("revoked");
    await w.financed();
    expect(await presentDebits(w.db, baseGw, DUE)).toEqual({ presented: 0, skipped: 0 });
  });
});

describe("presenting debits", () => {
  it("debits on the due date, and the money flows through the normal repayment waterfall", async () => {
    await activeMandate();
    const f = await w.financed(10_00_000_00n);
    expect(await presentDebits(w.db, baseGw, day(-1))).toEqual({ presented: 0, skipped: 0 }); // not due yet
    expect(await presentDebits(w.db, baseGw, DUE)).toEqual({ presented: 1, skipped: 0 });
    const [d] = await w.db.select().from(nachDebits);
    expect(d).toMatchObject({ status: "succeeded", attempt: 1, amount: 10_00_000_00n });
    expect((await w.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].status).toBe("paid");
    expect((await w.db.select().from(invoiceCollections).where(eq(invoiceCollections.invoiceId, f.invoiceId)))[0].closedAt).not.toBeNull();
  });

  it("never debits twice: a second run the same day does nothing", async () => {
    await activeMandate(); await w.financed();
    await presentDebits(w.db, baseGw, DUE);
    expect(await presentDebits(w.db, baseGw, DUE)).toEqual({ presented: 0, skipped: 0 }); // already paid and closed
    expect(await w.db.select().from(nachDebits)).toHaveLength(1);
  });

  it("a failed debit is reported, retried the next day, and stops after three tries", async () => {
    const g = failingGw();
    await activeMandate(g); const f = await w.financed();
    await presentDebits(w.db, g, DUE);
    expect((await w.db.select().from(nachDebits))[0]).toMatchObject({ status: "failed", failureReason: "insufficient funds" });
    expect(await templates()).toContain("nach_debit_failed");
    expect(await presentDebits(w.db, g, DUE)).toMatchObject({ presented: 0 }); // not twice in one day
    await presentDebits(w.db, g, day(1)); await presentDebits(w.db, g, day(2));
    expect(await w.db.select().from(nachDebits)).toHaveLength(3);
    expect(await presentDebits(w.db, g, day(3))).toMatchObject({ presented: 0 }); // out of tries: collections and recourse take over
    expect((await w.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].status).not.toBe("paid");
  });

  it("skips and warns once when the invoice is above the mandate limit", async () => {
    const m = await registerMandate(w.db, buyer, { ...bank, maxAmount: 1_00_000_00n }, baseGw);
    await applyMandateStatus(w.db, m.providerRef!, "active", undefined, baseGw);
    await w.financed(10_00_000_00n);
    expect(await presentDebits(w.db, baseGw, DUE)).toEqual({ presented: 0, skipped: 1 });
    await presentDebits(w.db, baseGw, day(1));
    expect((await templates()).filter((t) => t === "nach_over_limit")).toHaveLength(1);
    expect(await w.db.select().from(nachDebits)).toHaveLength(0);
  });

  it("a debit still processing is resolved later by the bank's webhook, once", async () => {
    const slow: Adapters = { ...baseGw, mandates: { ...baseGw.mandates, debit: async (p) => ({ debitRef: `D-${p.idempotencyKey}`, status: "processing" as const }) } };
    await activeMandate(slow); const f = await w.financed();
    await presentDebits(w.db, slow, DUE);
    const [d] = await w.db.select().from(nachDebits);
    expect(d.status).toBe("processing");
    expect(await presentDebits(w.db, slow, DUE)).toMatchObject({ presented: 0 }); // one in flight: never a second debit
    const r = await applyDebitResult(w.db, { idempotencyKey: d.idempotencyKey, status: "succeeded", utr: "UTR-1" }, baseGw, DUE);
    expect(r.status).toBe("succeeded");
    expect((await applyDebitResult(w.db, { idempotencyKey: d.idempotencyKey, status: "succeeded", utr: "UTR-1" }, baseGw, DUE)).status).toBe("replayed");
    expect((await w.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].status).toBe("paid");
  });
});

describe("pre-debit notice", () => {
  it("goes out the day before, once, and only to buyers with an active mandate", async () => {
    await w.financed();
    expect(await sendPreDebitNotices(w.db, baseGw, day(-1))).toBe(0); // no mandate yet
    await activeMandate();
    expect(await sendPreDebitNotices(w.db, baseGw, day(-2))).toBe(0); // too early
    expect(await sendPreDebitNotices(w.db, baseGw, day(-1))).toBe(1);
    expect(await sendPreDebitNotices(w.db, baseGw, day(-1))).toBe(0);
    expect(await templates()).toContain("nach_pre_debit");
  });
});
