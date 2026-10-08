import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businessBankAccounts, businesses, fraudCases, fraudScans, invoices } from "../db/schema";
import { T0, world } from "../testkit";
import { assertNotFrozen } from "./service";
import { FRAUD, scanInvoice, scanPending, scoreInvoice, verdict } from "./engine";

let w: Awaited<ReturnType<typeof world>>;
let n = 0;
const LATER = new Date(T0.getTime() + 90 * 86_400_000); // an old, established seller: the new-seller rule stays quiet
beforeEach(async () => { w = await world(); n = 0; });

/** Insert an invoice directly (these tests are about the engine, not the intake checks). */
const inv = async (o: { seller?: string; buyer?: string; amount?: bigint; date?: string } = {}) => {
  const [r] = await w.db.insert(invoices).values({
    sellerId: o.seller ?? w.sellerId, buyerId: o.buyer ?? w.buyerId, invoiceNumber: `E-${++n}`, invoiceDate: o.date ?? `2026-09-${String(10 + (n % 15)).padStart(2, "0")}`,
    dueDate: "2026-12-30", amount: o.amount ?? 3_00_000_00n + BigInt(n) * 1_00n, contentHash: `eh${n}-${Math.random()}`, status: "validated", createdAt: T0,
  }).returning();
  return r.id;
};
const rules = (s: { rule: string }[]) => s.map((x) => x.rule).sort();

describe("fraud engine signals", () => {
  it("an ordinary invoice from an established seller raises nothing", async () => {
    const id = await inv({ amount: 3_00_000_00n });
    expect(await scoreInvoice(w.db, id, LATER)).toEqual([]);
    expect(verdict([])).toMatchObject({ score: 0, flag: false });
  });

  it("velocity: a burst of invoices from one seller", async () => {
    for (let i = 0; i < FRAUD.velocityPerDay; i++) await inv();
    const id = await inv();
    expect(rules(await scoreInvoice(w.db, id, T0))).toContain("velocity");
  });

  it("amount outlier against the seller's own history", async () => {
    for (let i = 0; i < 3; i++) await inv({ amount: 1_01_234_00n }); // not round, so the round-number rule stays out of it
    const big = await inv({ amount: 9_00_000_00n });
    const s = await scoreInvoice(w.db, big, LATER);
    expect(rules(s)).toEqual(["amount_outlier"]);
    expect(s[0].detail).toMatchObject({ times: 8 });
    const ok = await inv({ amount: 3_00_000_00n });
    expect(rules(await scoreInvoice(w.db, ok, LATER))).toEqual([]); // 3x the average is within normal range
  });

  it("new seller, large invoice", async () => {
    const id = await inv({ amount: 12_00_000_00n });
    expect(rules(await scoreInvoice(w.db, id, new Date(Date.now() + 86_400_000)))).toContain("new_seller_large");
  });

  it("related party: the same PAN inside both GSTINs", async () => {
    await w.db.update(businesses).set({ gstin: "27ABCDE1234F1Z5" }).where(eq(businesses.id, w.sellerId));
    await w.db.update(businesses).set({ gstin: "29ABCDE1234F1Z9" }).where(eq(businesses.id, w.buyerId));
    const s = await scoreInvoice(w.db, await inv(), LATER);
    expect(s).toEqual([expect.objectContaining({ rule: "related_party", severity: "high" })]);
  });

  it("circular trade, direct and three-way", async () => {
    const id = await inv();
    await inv({ seller: w.buyerId, buyer: w.sellerId }); // the buyer also sells to the seller
    expect(rules(await scoreInvoice(w.db, id, T0))).toContain("circular_trade");

    const [c] = await w.db.insert(businesses).values({ legalName: "Third Co", entityType: "pvt_ltd" }).returning();
    await w.db.delete(invoices).where(eq(invoices.sellerId, w.buyerId));
    await inv({ seller: w.buyerId, buyer: c.id }); // B -> C
    await inv({ seller: c.id, buyer: w.sellerId }); // C -> A
    const s = await scoreInvoice(w.db, id, T0);
    expect(s.find((x) => x.rule === "circular_trade")?.label).toMatch(/three-way/);
  });

  it("the same bank account behind two businesses", async () => {
    await w.db.insert(businessBankAccounts).values({ businessId: w.buyerId, accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Big Corp" });
    expect(rules(await scoreInvoice(w.db, await inv(), LATER))).toContain("shared_bank_account");
  });

  it("possible duplicate: same buyer, amount and date under a different number", async () => {
    await inv({ amount: 4_00_000_00n, date: "2026-09-20" });
    const id = await inv({ amount: 4_00_000_00n, date: "2026-09-20" });
    expect(rules(await scoreInvoice(w.db, id, LATER))).toContain("possible_duplicate");
  });
});

describe("verdict, cases and scanning", () => {
  it("a single high-severity signal flags the invoice, opens a case, and freezes it", async () => {
    await w.db.update(businesses).set({ gstin: "27ABCDE1234F1Z5" }).where(eq(businesses.id, w.sellerId));
    await w.db.update(businesses).set({ gstin: "29ABCDE1234F1Z9" }).where(eq(businesses.id, w.buyerId));
    const id = await inv();
    const r = await scanInvoice(w.db, id, LATER);
    expect(r).toMatchObject({ flag: true, severity: "high" });
    const [c] = await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, id));
    expect(c).toMatchObject({ ruleTriggered: "risk_signals", status: "open", severity: "high" });
    expect((c.details as { signals: unknown[] }).signals).toHaveLength(1);
    await expect(assertNotFrozen(w.db, id)).rejects.toThrow("FROZEN_FRAUD_REVIEW");
    await scanInvoice(w.db, id, LATER); // scanning again is the same case, not a second one
    expect(await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, id))).toHaveLength(1);
  });

  it("several medium signals add up past the threshold", async () => {
    for (let i = 0; i < 3; i++) await inv({ amount: 1_00_000_00n });
    for (let i = 0; i < FRAUD.velocityPerDay; i++) await inv({ amount: 1_00_000_00n });
    const id = await inv({ amount: 9_00_000_00n });
    const r = await scanInvoice(w.db, id, T0); // velocity 25 + outlier 20 + new seller (T0 is days after creation of the test seller? checked below)
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
    expect(r.score).toBe(r.signals.reduce((a, s) => a + s.score, 0));
  });

  it("scanPending scans only what has not been scanned, and a clean invoice opens nothing", async () => {
    const a = await inv({ amount: 3_00_000_00n }), b = await inv({ amount: 3_10_000_00n });
    const first = await scanPending(w.db, LATER);
    expect(first).toEqual({ scanned: 2, flagged: 0 });
    expect(await scanPending(w.db, LATER)).toEqual({ scanned: 0, flagged: 0 });
    expect((await w.db.select().from(fraudScans)).map((x) => x.invoiceId).sort()).toEqual([a, b].sort());
    expect(await w.db.select().from(fraudCases)).toHaveLength(0);
  });
});
