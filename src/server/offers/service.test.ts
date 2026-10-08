import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { businesses, financingOffers, invoices } from "../db/schema";
import { submitKyb, submitLightKyb } from "../kyb/service";
import { linkBuyer } from "../relationships/service";
import { createInvoice } from "../invoices/service";
import { recordConsent, underwriteInvoice } from "../underwriting/service";
import { mock } from "../integrations/mock";
import { priceOffer } from "./pricing";
import { acceptOffer, expireOffers, generateOffer, generateOffers, rejectOffer, type SellerActor } from "./service";
import type { Database } from "../db/client";

const T0 = new Date("2026-10-06T00:00:00Z");
const hrs = (h: number) => new Date(T0.getTime() + h * 3_600_000);
let db: Database, sellerId: string, buyerId: string, seller: SellerActor;
const gw = { ...mock, bureau: { pull: async () => ({ score: 780, noHit: false }) } };

describe("priceOffer", () => {
  it("₹10L invoice, 90% advance, 12% p.a., 45 days, 0.5% fee", () => {
    const p = priceOffer({ amount: 10_00_000_00n, advanceBps: 9000, discountBps: 1200, tenorDays: 45 });
    expect(p.advanceAmount).toBe(9_00_000_00n);
    expect(p.feeAmount).toBe(5_000_00n);
    expect(p.expectedDiscount).toBe(13_315_06n); // 9,00,000 * 12% * 45/365 = 13,315.068 (floored to the paisa)
    expect(p.netDisbursal).toBe(8_95_000_00n);
    expect(p.effectiveAprBps).toBeGreaterThan(1200); // fee makes the all-in rate higher than the headline
  });
  it("rejects nonsense", () => {
    expect(() => priceOffer({ amount: 1n, advanceBps: 9000, discountBps: 1200, tenorDays: 0 })).toThrow();
  });
});

beforeEach(async () => {
  db = await testDb();
  sellerId = (await db.insert(businesses).values({ legalName: "Seller Co", entityType: "pvt_ltd" }).returning())[0].id;
  buyerId = (await db.insert(businesses).values({ legalName: "Big Corp", entityType: "pvt_ltd" }).returning())[0].id;
  await submitKyb(db, {
    businessId: sellerId, pan: "ABCDE1234F", gstin: "27AAAAA1111A1Z5", ubos: [{ name: "Ravi", shareholdingBps: 10000 }],
    bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Seller Co" },
  });
  await submitLightKyb(db, { businessId: buyerId, gstin: "29BBBBB2222B1Z5", pan: "BCDEF2345G" });
  await linkBuyer(db, { sellerId, buyerGstin: "29BBBBB2222B1Z5", buyerEmail: "ap@big.com" });
  await recordConsent(db, { businessId: sellerId, text: "ok" });
  await recordConsent(db, { businessId: buyerId, text: "ok" }); // else buyer has no bureau data and grades D
  seller = { id: "00000000-0000-0000-0000-000000000001", role: "seller", businessId: sellerId };
});

let n = 0;
async function approvedInvoice(amount = 10_00_000_00n) {
  const { id } = await createInvoice(db, {
    sellerId, buyerId, invoiceNumber: `INV-${++n}`, invoiceDate: "2026-09-25", dueDate: "2026-11-20",
    amount, contentHash: `h${n}`, irn: `IRN-OK-${n}`,
  }, mock, T0);
  await db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id));
  await underwriteInvoice(db, id, gw, T0);
  return id;
}

async function offerAt(invoiceId: string, now: Date) {
  const r = await generateOffer(db, invoiceId, gw, now);
  if (r.unfunded) throw new Error("unfunded");
  return r.offer;
}

describe("generateOffer", () => {
  it("prices from the underwriting decision and is idempotent while live", async () => {
    const id = await approvedInvoice();
    const o = await offerAt(id, T0);
    expect(o).toMatchObject({ advanceAmount: 9_00_000_00n, tenorDays: 45, status: "open", financierId: null });
    expect((await offerAt(id, hrs(1))).id).toBe(o.id);
    expect(await db.select().from(financingOffers)).toHaveLength(1);
  });

  it("refuses unapproved / ineligible invoices", async () => {
    const id = await approvedInvoice();
    await db.update(invoices).set({ disputeFlag: true }).where(eq(invoices.id, id));
    await expect(generateOffer(db, id, gw, T0)).rejects.toThrow(/cannot be offered/);
  });

  it("platform capacity: over the balance sheet => unfunded, nothing created", async () => {
    process.env.PLATFORM_CAPITAL_PAISE = "100000000"; // ₹10L; a ₹9L advance fits once, not twice
    try {
      const a = await approvedInvoice(), b = await approvedInvoice();
      await acceptOffer(db, (await offerAt(a, T0)).id, seller, hrs(1)); // accepted offers count as deployed capital
      expect(await generateOffer(db, b, gw, hrs(2))).toEqual({ unfunded: true });
      expect(await db.select().from(financingOffers)).toHaveLength(1);
    } finally { delete process.env.PLATFORM_CAPITAL_PAISE; }
  });
});

describe("accept / reject / expire", () => {
  const offerFor = async () => offerAt(await approvedInvoice(), T0);

  it("accept: only the invoice's seller, only while open", async () => {
    const o = await offerFor();
    await expect(acceptOffer(db, o.id, { ...seller, businessId: buyerId }, hrs(1))).rejects.toThrow("FORBIDDEN");
    await expect(acceptOffer(db, o.id, { ...seller, role: "buyer" }, hrs(1))).rejects.toThrow("FORBIDDEN");
    await acceptOffer(db, o.id, seller, hrs(1));
    expect((await db.select().from(financingOffers))[0]).toMatchObject({ status: "accepted", acceptedBy: seller.id });
    await expect(acceptOffer(db, o.id, seller, hrs(2))).rejects.toThrow(/offer is accepted/);
  });

  it("accepting after expiry fails and persists the expiry; a fresh offer can then be generated", async () => {
    const o = await offerFor();
    await expect(acceptOffer(db, o.id, seller, hrs(25))).rejects.toThrow(/expired/);
    expect((await db.select().from(financingOffers))[0].status).toBe("expired");
    const fresh = await offerAt(o.invoiceId, hrs(26));
    expect(fresh.id).not.toBe(o.id);
    expect(fresh.tenorDays).toBe(44); // re-priced to the shorter remaining tenor
  });

  it("reject frees the invoice; the worker does not auto re-offer it", async () => {
    const o = await offerFor();
    await rejectOffer(db, o.id, seller, hrs(1));
    expect(await generateOffers(db, gw)).toBe(0);
  });

  it("expireOffers sweeps; generateOffers offers new approved invoices once", async () => {
    const o = await offerFor();
    expect(await expireOffers(db, hrs(23))).toBe(0);
    expect(await expireOffers(db, hrs(24))).toBe(1);
    await approvedInvoice();
    expect(await generateOffers(db, gw)).toBe(1);
    expect(await generateOffers(db, gw)).toBe(0);
    void o;
  });
});
