import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, buyerInvites, buyerSellerRelationships, financingOffers, foreignReceipts, invoiceCollections, invoices, repayments, users, virtualAccounts } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { recordConsent, reviewUnderwriting, underwriteInvoice } from "../underwriting/service";
import { generateOffer, acceptOffer } from "../offers/service";
import { prepareAgreements, signInApp } from "../agreements/service";
import { executeDisbursement, fundEscrow, requestDisbursement } from "../disbursements/service";
import { ACCOUNTS, balance } from "../ledger/accounts";
import { CROSS, createExportInvoice, exposure, linkForeignBuyer, lockRate, recordForeignPayment, submitForeignKyb, toPaise } from "./service";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });
const staff = { staffId: "00000000-0000-0000-0000-0000000000a1", staffRole: "ops" };

/** An overseas buyer with a login, not yet verified. */
async function overseas(name = "Acme Inc") {
  const [b] = await w.db.insert(businesses).values({ legalName: name, entityType: "foreign" }).returning();
  await w.db.insert(users).values({ name, email: `ap@${b.id}.com`, role: "buyer", businessId: b.id });
  await recordConsent(w.db, { businessId: b.id, text: "ok" });
  return b;
}
const hash = (() => { let n = 0; return () => `xh${++n}`; })();
const exportInv = (buyerId: string, o: Partial<Parameters<typeof createExportInvoice>[1]> = {}) =>
  createExportInvoice(w.db, {
    sellerId: w.sellerId, buyerId, invoiceNumber: `EXP-${hash()}`, invoiceDate: "2026-09-25", dueDate: "2026-11-20",
    currency: "USD", foreignAmount: 12_000_00n, purposeCode: "P0802", contentHash: hash(), ...o,
  }, gw, T0);
/** Overseas buyers have no Indian bureau record, so the engine refers them to an analyst. The analyst approves at the engine's terms. */
async function approve(invoiceId: string) {
  await w.db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, invoiceId));
  const d = await underwriteInvoice(w.db, invoiceId, gw, T0);
  expect(d.decision).toBe("referred");
  await reviewUnderwriting(w.db, { decisionId: d.id, reviewerId: staff.staffId, reviewerRole: "ops", outcome: "approve", note: "checked buyer credit report" });
  return d;
}
async function verifiedBuyer() {
  const b = await overseas();
  await linkForeignBuyer(w.db, { sellerId: w.sellerId, country: "us", taxId: "us-ein-123456", buyerEmail: "ap@acme.com" });
  await submitForeignKyb(w.db, { businessId: b.id, country: "US", taxId: "US-EIN-123456" }, gw);
  return b;
}

describe("rate maths", () => {
  it("locks the rate below market and converts cents to paise exactly", async () => {
    const r = await lockRate(gw, "USD");
    expect(r.midMicro).toBe(83_500_000n);
    expect(r.lockedMicro).toBe(81_830_000n); // 2% under mid
    expect(toPaise(12_000_00n, r.lockedMicro)).toBe(98_196_000n); // USD 12,000.00 -> Rs 9,81,960.00
    await expect(lockRate(gw, "JPY")).rejects.toThrow("we finance invoices in");
  });
});

describe("overseas buyers", () => {
  it("an invitation links when the buyer verifies, whichever order it happens in", async () => {
    const b = await overseas();
    expect(await linkForeignBuyer(w.db, { sellerId: w.sellerId, country: "US", taxId: "US-EIN-123456", buyerEmail: "ap@acme.com" })).toMatchObject({ invited: true });
    expect((await w.db.select().from(buyerInvites))[0].buyerGstin).toBe("FOREIGN:US:US-EIN-123456");
    expect(await submitForeignKyb(w.db, { businessId: b.id, country: "US", taxId: "US-EIN-123456" }, gw)).toEqual({ status: "approved" });
    expect(await w.db.select().from(buyerSellerRelationships).where(eq(buyerSellerRelationships.buyerId, b.id))).toHaveLength(1);
    expect((await w.db.select().from(buyerInvites))[0].status).toBe("linked");
    expect(await linkForeignBuyer(w.db, { sellerId: w.sellerId, country: "US", taxId: "US-EIN-123456", buyerEmail: "x@y.com" })).toMatchObject({ linked: true }); // already verified
  });
  it("refuses blocked countries, India, and sanctions hits go to review", async () => {
    await expect(linkForeignBuyer(w.db, { sellerId: w.sellerId, country: "IR", taxId: "12345678", buyerEmail: "a@b.com" })).rejects.toThrow("cannot finance");
    await expect(linkForeignBuyer(w.db, { sellerId: w.sellerId, country: "IN", taxId: "12345678", buyerEmail: "a@b.com" })).rejects.toThrow("not India");
    await expect(linkForeignBuyer(w.db, { sellerId: w.sellerId, country: "US", taxId: "1", buyerEmail: "a@b.com" })).rejects.toThrow("tax or registration");
    const [b] = await w.db.insert(businesses).values({ legalName: "SANCTION Traders Ltd", entityType: "foreign" }).returning();
    expect(await submitForeignKyb(w.db, { businessId: b.id, country: "GB", taxId: "GB123456789" }, gw)).toEqual({ status: "under_review" });
    expect((await w.db.select().from(businesses).where(eq(businesses.id, b.id)))[0].kybStatus).toBe("under_review");
  });
});

describe("export invoices", () => {
  it("stores the locked rate and the paperwork; the rupee amount drives everything else", async () => {
    const b = await verifiedBuyer();
    const r = await exportInv(b.id);
    const [inv] = await w.db.select().from(invoices).where(eq(invoices.id, r.id));
    expect(inv).toMatchObject({ currency: "USD", foreignAmount: 12_000_00n, fxRateMicro: 81_830_000n, amount: 98_196_000n, purposeCode: "P0802", status: "validated" });
  });
  it("needs an overseas, verified buyer, supported currency and the right paperwork", async () => {
    const b = await verifiedBuyer();
    await expect(exportInv(w.buyerId)).rejects.toThrow("not an overseas company");
    await expect(exportInv(b.id, { purposeCode: undefined })).rejects.toThrow("shipping bill");
    await expect(exportInv(b.id, { purposeCode: "0802" })).rejects.toThrow("P0102");
    await expect(exportInv(b.id, { currency: "JPY" })).rejects.toThrow("we finance invoices in");
    await expect(exportInv(b.id, { foreignAmount: 0n })).rejects.toThrow("enter the invoice amount");
    const unverified = await overseas("Other Inc");
    await expect(exportInv(unverified.id)).rejects.toThrow("not an overseas company"); // it has not given its country yet
  });
  it("is referred to an analyst, then advanced less and priced higher than the same invoice at home", async () => {
    const b = await verifiedBuyer();
    const r = await exportInv(b.id, { foreignAmount: 12_000_00n });
    const d = await approve(r.id);
    const o = await generateOffer(w.db, r.id, gw, T0);
    if (o.unfunded) throw new Error("unfunded");
    const base = d.advanceRateBps; // grade A, less the no-IRN cut that exports also carry
    expect(o.offer.advanceAmount).toBe((98_196_000n * BigInt(base - CROSS.advanceCutBps)) / 10_000n);
    expect(o.offer.discountBps).toBe(d.discountRateBps + CROSS.riskPremiumBps);
  });
});

describe("a foreign-currency payment", () => {
  async function financedExport() {
    const b = await verifiedBuyer();
    const r = await exportInv(b.id);
    await approve(r.id);
    const o = await generateOffer(w.db, r.id, gw, T0);
    if (o.unfunded) throw new Error("unfunded");
    await acceptOffer(w.db, o.offer.id, w.sellerActor, T0);
    await prepareAgreements(w.db, o.offer.id, gw, T0);
    await signInApp(w.db, { offerId: o.offer.id, actor: w.sellerActor }, T0);
    await fundEscrow(w.db, { amount: 50_00_000_00n, ref: "fx-fund", ...staff });
    const d = await requestDisbursement(w.db, o.offer.id);
    await executeDisbursement(w.db, d.id, gw, T0);
    const [va] = await w.db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, r.id));
    return { invoiceId: r.id, account: va.accountNumber, offer: o.offer };
  }
  const pay = (account: string, cents: bigint, utr: string, currency = "USD") =>
    recordForeignPayment(w.db, { accountNumber: account, currency, foreignAmount: cents, utr, receivedAt: new Date("2026-11-20T10:00:00Z") }, gw, new Date("2026-11-20T10:00:00Z"));

  it("converts at the market rate less the bank's spread, records it, and settles the invoice", async () => {
    const { invoiceId, account, offer } = await financedExport();
    const r = await pay(account, 12_000_00n, "FX-UTR-1");
    expect(r.status).toBe("converted");
    const [rec] = await w.db.select().from(foreignReceipts);
    expect(rec).toMatchObject({ currency: "USD", foreignAmount: 12_000_00n, rateMicro: 83_082_500n }); // 83.5 less 0.5%
    expect(rec.inrAmount).toBe(toPaise(12_000_00n, 83_082_500n));
    expect((await w.db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0].status).toBe("paid");
    expect(await balance(w.db, ACCOUNTS.receivable(w.sellerId))).toBe(0n);
    expect((await w.db.select().from(repayments))[0].amount).toBe(rec.inrAmount);
    expect(offer.advanceAmount).toBeLessThan(rec.inrAmount); // the buffer and the cut leave room, so the seller gets a surplus
  });
  it("a payment that falls short because of the rate leaves the balance with the seller", async () => {
    const { invoiceId, account } = await financedExport();
    await pay(account, 3_000_00n, "FX-UTR-2");
    const [c] = await w.db.select().from(invoiceCollections).where(eq(invoiceCollections.invoiceId, invoiceId));
    expect(c.closedAt).toBeNull();
    expect(c.principal + c.discount).toBeGreaterThan(0n);
    expect((await w.db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0].status).toBe("financed");
  });
  it("is idempotent, and refuses the wrong currency or an unknown account", async () => {
    const { account } = await financedExport();
    await pay(account, 12_000_00n, "FX-UTR-3");
    expect((await pay(account, 12_000_00n, "FX-UTR-3")).status).toBe("replayed");
    expect(await w.db.select().from(foreignReceipts)).toHaveLength(1);
    await expect(pay(account, 100n, "FX-UTR-4", "EUR")).rejects.toThrow("is in USD");
    await expect(pay("MARI000000000000", 100n, "FX-UTR-5")).rejects.toThrow("unknown collection account");
  });
  it("reports open exposure by currency and country", async () => {
    await financedExport();
    const e = await exposure(w.db);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ currency: "USD", country: "US", invoices: 1, foreign: 12_000_00n });
    expect(e[0].principal).toBeGreaterThan(0n);
    void financingOffers;
  });
});
