import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bids, businesses, financingOffers, invoices, virtualAccounts } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { prepareAgreements, signInApp } from "../agreements/service";
import { executeDisbursement, requestDisbursement } from "../disbursements/service";
import { recordIncomingPayment, writeOff } from "../collections/service";
import { ACCOUNTS, balance } from "../ledger/accounts";
import { acceptBid, bidsFor, dealFlow, expireBids, financierShare, placeBid, platformCash, portfolio, position, recordFunding, recordWithdrawal, statement, withdrawBid } from "./service";

let w: Awaited<ReturnType<typeof world>>;
const ops = { staffId: "00000000-0000-0000-0000-0000000000a1", staffRole: "ops" };
const admin = { id: "00000000-0000-0000-0000-0000000000a2", role: "admin" };
const L = 1_00_000_00n;
beforeEach(async () => { w = await world(); });

const bid = (f: { actor: { id: string; role: string; businessId: string } }, invoiceId: string, discountBps = 1000, advanceBps = 9000) =>
  placeBid(w.db, f.actor, { invoiceId, advanceBps, discountBps }, gw, T0);

/** Fund a financier, put an invoice up, bid, and let the seller accept. */
async function funded(fund = 50n * L) {
  const f = await w.financier("Capital One", fund);
  const { invoiceId } = await w.offered();
  const b = await bid(f, invoiceId);
  const offer = await acceptBid(w.db, b.id, w.sellerActor, gw, T0);
  return { f, invoiceId, offer, bid: b };
}
async function payOut(offerId: string) {
  await prepareAgreements(w.db, offerId, gw, T0);
  await signInApp(w.db, { offerId, actor: w.sellerActor }, T0);
  const d = await requestDisbursement(w.db, offerId);
  await executeDisbursement(w.db, d.id, gw, T0);
}
const accountOf = async (invoiceId: string) => (await w.db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, invoiceId)))[0].accountNumber;
const payDay = (account: string, amount: bigint, utr: string) =>
  recordIncomingPayment(w.db, { accountNumber: account, amount, utr, receivedAt: new Date("2026-11-20T10:00:00Z") }, gw, new Date("2026-11-20T10:00:00Z"));

describe("funding", () => {
  it("only staff record funding, it is idempotent, and withdrawals cannot exceed what is available", async () => {
    const f = await w.financier();
    await expect(recordFunding(w.db, { financierId: f.id, amount: 10n * L, ref: "x", staffId: ops.staffId, staffRole: "seller" })).rejects.toThrow("forbidden");
    await recordFunding(w.db, { financierId: f.id, amount: 10n * L, ref: "x", ...ops });
    await recordFunding(w.db, { financierId: f.id, amount: 10n * L, ref: "x", ...ops }); // replay
    expect((await position(w.db, f.id)).funds).toBe(10n * L);
    await expect(recordWithdrawal(w.db, { financierId: f.id, amount: 11n * L, ref: "w1", ...ops })).rejects.toThrow("more than");
    await recordWithdrawal(w.db, { financierId: f.id, amount: 4n * L, ref: "w2", ...ops });
    expect((await position(w.db, f.id)).available).toBe(6n * L);
    expect((await statement(w.db, f.id)).map((r) => r.running)).toEqual([10n * L, 6n * L]);
  });
  it("refuses a company that is not an approved financier", async () => {
    await expect(recordFunding(w.db, { financierId: w.sellerId, amount: L, ref: "s", ...ops })).rejects.toThrow("not a financier");
  });
});

describe("bidding", () => {
  it("shows approved invoices without the seller's identity", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    const flow = await dealFlow(w.db, f.id, T0);
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({ invoiceId, grade: "A", maxAdvanceBps: 9000, tenorDays: 45, buyer: "Big Corp" });
    expect(JSON.stringify(flow, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("Seller Co");
  });
  it("enforces discount range, grade advance cap and available funds", async () => {
    const f = await w.financier("Capital One", 5n * L);
    const { invoiceId } = await w.offered();
    await expect(bid(f, invoiceId, 100)).rejects.toThrow("between");
    await expect(bid(f, invoiceId, 5000)).rejects.toThrow("between");
    await expect(bid(f, invoiceId, 1000, 9500)).rejects.toThrow("at most 90%");
    await expect(bid(f, invoiceId, 1000, 9000)).rejects.toThrow("enough available funds"); // ₹9L advance vs ₹5L funds
    await expect(bid(f, invoiceId, 1000, 4500)).resolves.toMatchObject({ advanceAmount: 4_50_000_00n });
  });
  it("needs the financier role and an approved verification", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    await expect(placeBid(w.db, { ...w.sellerActor }, { invoiceId, advanceBps: 9000, discountBps: 1000 }, gw, T0)).rejects.toThrow("FORBIDDEN");
    await w.db.update(businesses).set({ kybStatus: "under_review" }).where(eq(businesses.id, f.id));
    await expect(bid(f, invoiceId)).rejects.toThrow("not approved");
  });
  it("a new bid replaces the financier's previous one; withdrawing closes it", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    const a = await bid(f, invoiceId, 1200);
    const b = await bid(f, invoiceId, 1000);
    expect((await w.db.select().from(bids).where(eq(bids.id, a.id)))[0].status).toBe("withdrawn");
    await withdrawBid(w.db, f.actor, b.id, T0);
    expect((await bidsFor(w.db, [invoiceId], T0)).get(invoiceId)).toBeUndefined();
    await expect(withdrawBid(w.db, f.actor, b.id, T0)).rejects.toThrow("no longer open");
  });
  it("bids expire", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    const b = await bid(f, invoiceId);
    const later = new Date(T0.getTime() + 49 * 3_600_000);
    expect((await bidsFor(w.db, [invoiceId], later)).size).toBe(0);
    await expect(acceptBid(w.db, b.id, w.sellerActor, gw, later)).rejects.toThrow("expired");
    expect(await expireBids(w.db, later)).toBe(0); // already marked by the failed accept
  });
});

describe("choosing a bid", () => {
  it("ranks by the seller's all-in rate; accepting one closes the rest and the platform offer", async () => {
    const f1 = await w.financier("Cheap Capital", 50n * L), f2 = await w.financier("Dear Capital", 50n * L);
    const { invoiceId } = await w.offered();
    const dear = await bid(f2, invoiceId, 1800), cheap = await bid(f1, invoiceId, 900);
    const list = (await bidsFor(w.db, [invoiceId], T0)).get(invoiceId)!;
    expect(list.map((b) => b.id)).toEqual([cheap.id, dear.id]);
    expect(list[0].effectiveAprBps).toBeLessThan(list[1].effectiveAprBps);
    const offer = await acceptBid(w.db, cheap.id, w.sellerActor, gw, T0);
    expect(offer).toMatchObject({ financierId: f1.id, status: "accepted", discountBps: 900 });
    expect((await w.db.select().from(bids).where(eq(bids.id, dear.id)))[0].status).toBe("rejected");
    const offers = await w.db.select().from(financingOffers).where(eq(financingOffers.invoiceId, invoiceId));
    expect(offers.map((o) => o.status).sort()).toEqual(["accepted", "rejected"]);
  });
  it("only the invoice's seller can accept, and only once", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    const b = await bid(f, invoiceId);
    await expect(acceptBid(w.db, b.id, { ...w.sellerActor, businessId: w.buyerId }, gw, T0)).rejects.toThrow("FORBIDDEN");
    await acceptBid(w.db, b.id, w.sellerActor, gw, T0);
    await expect(acceptBid(w.db, b.id, w.sellerActor, gw, T0)).rejects.toThrow("bid is accepted");
  });
  it("reserves the financier's cash: accepted advances cannot be bid on twice or withdrawn", async () => {
    const { f, offer } = await funded(10n * L); // ₹9L of ₹10L reserved
    expect(await position(w.db, f.id)).toMatchObject({ funds: 10n * L, reserved: offer.advanceAmount, available: 10n * L - offer.advanceAmount });
    const { invoiceId: second } = await w.offered();
    await expect(bid(f, second)).rejects.toThrow("enough available funds");
    await expect(recordWithdrawal(w.db, { financierId: f.id, amount: 2n * L, ref: "w", ...ops })).rejects.toThrow("more than");
  });
  it("refuses a bid whose financier withdrew the funds after bidding", async () => {
    const f = await w.financier("Capital One", 10n * L);
    const { invoiceId } = await w.offered();
    const b = await bid(f, invoiceId);
    await recordWithdrawal(w.db, { financierId: f.id, amount: 5n * L, ref: "w", ...ops });
    await expect(acceptBid(w.db, b.id, w.sellerActor, gw, T0)).rejects.toThrow("no longer has the funds");
  });
});

describe("a financier-funded invoice end to end", () => {
  it("pays the seller from the financier's cash and moves it to deployed", async () => {
    const { f, offer, invoiceId } = await funded();
    await payOut(offer.id);
    expect((await w.db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0].status).toBe("financed");
    expect(await position(w.db, f.id)).toMatchObject({ funds: 50n * L - offer.advanceAmount, deployed: offer.advanceAmount, reserved: 0n });
    expect(await balance(w.db, ACCOUNTS.receivable(w.sellerId))).toBe(offer.advanceAmount);
    expect((await portfolio(w.db, f.id, T0))[0]).toMatchObject({ status: "financed", outstandingPrincipal: offer.advanceAmount });
  });
  it("repayment returns principal and the financier's share of discount; the platform keeps the rest", async () => {
    const { f, offer, invoiceId } = await funded();
    await payOut(offer.id);
    const r = await payDay(await accountOf(invoiceId), 10n * L, "UTR-M1");
    expect(r).toMatchObject({ status: "applied", closed: true });
    const discount = (offer.advanceAmount * 1000n * 45n) / (10_000n * 365n);
    const share = financierShare(discount);
    expect(share).toBeLessThan(discount);
    expect(await position(w.db, f.id)).toMatchObject({ funds: 50n * L + share, deployed: 0n });
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBe(-(discount - share)); // the platform's 20%
    expect((await statement(w.db, f.id)).at(-1)!.running).toBe(50n * L + share);
  });
  it("a write-off is the financier's loss, not the platform's", async () => {
    const { f, offer, invoiceId } = await funded();
    await payOut(offer.id);
    await expect(writeOff(w.db, invoiceId, admin, "gone", new Date("2027-03-01T00:00:00Z"))).resolves.toMatchObject({ principal: offer.advanceAmount });
    expect(await balance(w.db, ACCOUNTS.creditLoss)).toBe(0n);
    expect(await position(w.db, f.id)).toMatchObject({ funds: 50n * L - offer.advanceAmount, deployed: 0n });
  });
  it("platform-funded payouts cannot spend a financier's cash", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const platformOffer = await w.acceptedOffer(); // escrow holds only the financier's money
    await prepareAgreements(w.db, platformOffer, gw, T0);
    await signInApp(w.db, { offerId: platformOffer, actor: w.sellerActor }, T0);
    const d = await requestDisbursement(w.db, platformOffer);
    await expect(executeDisbursement(w.db, d.id, gw, T0)).rejects.toThrow("ESCROW_INSUFFICIENT");
    expect((await position(w.db, f.id)).funds).toBe(50n * L);
    expect(await platformCash(w.db)).toBe(0n);
  });
});
