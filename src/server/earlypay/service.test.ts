import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { earlyPayments, financingOffers, invoices, sellerPayouts, unmatchedCredits, virtualAccounts } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { generateOffer } from "../offers/service";
import { recordIncomingPayment, runSurplusPayouts } from "../collections/service";
import { ACCOUNTS, balance } from "../ledger/accounts";
import { DD, expireEarlyPayments, proposeEarlyPayment, quoteEarly, respondEarlyPayment } from "./service";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });
const L = 1_00_000_00n;
const buyer = () => ({ id: w.buyerUserId, role: "buyer", businessId: w.buyerId });
const propose = (invoiceId: string, discountBps = 1200, now = T0) => proposeEarlyPayment(w.db, buyer(), { invoiceId, discountBps }, gw, now);
const accountOf = async (invoiceId: string) => (await w.db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, invoiceId)))[0].accountNumber;
const pay = (account: string, amount: bigint, utr: string) =>
  recordIncomingPayment(w.db, { accountNumber: account, amount, utr, receivedAt: T0 }, gw, T0);

describe("quoteEarly", () => {
  it("scales the discount with how early, and the parts add up", () => {
    const near = quoteEarly(10n * L, 10, 1200), far = quoteEarly(10n * L, 40, 1200);
    expect(far.discount).toBe(4n * near.discount + ((10n * L * 1200n * 40n) / (10_000n * 365n) - 4n * near.discount));
    expect(far.discount).toBeGreaterThan(near.discount * 3n);
    expect(far.net + far.discount).toBe(10n * L);
    expect(far.fee).toBe((10n * L * 25n) / 10_000n);
    expect(far.sellerCostBps).toBeGreaterThan(1200); // the fee makes the seller's all-in cost higher than the headline rate
  });
});

describe("proposing", () => {
  it("only the invoice's buyer, only on a confirmed unfinanced invoice, inside the discount range and early enough", async () => {
    const { invoiceId } = await w.offered(); // due 2026-11-20, 45 days from T0
    await expect(proposeEarlyPayment(w.db, { ...buyer(), role: "seller" }, { invoiceId, discountBps: 1200 }, gw, T0)).rejects.toThrow("FORBIDDEN");
    await expect(proposeEarlyPayment(w.db, { ...buyer(), businessId: w.sellerId }, { invoiceId, discountBps: 1200 }, gw, T0)).rejects.toThrow("FORBIDDEN");
    await expect(propose(invoiceId, 100)).rejects.toThrow("between");
    await expect(propose(invoiceId, 1200, new Date("2026-11-18T00:00:00Z"))).rejects.toThrow("at least");
    const p = await propose(invoiceId);
    expect(p).toMatchObject({ status: "proposed", daysEarly: 45, discountBps: 1200 });
    expect(p.netAmount + p.discountAmount).toBe(10n * L);
  });
  it("a new proposal replaces the unanswered one; a financed invoice cannot be paid early", async () => {
    const { invoiceId } = await w.offered();
    const a = await propose(invoiceId, 1200), b = await propose(invoiceId, 1500);
    expect((await w.db.select().from(earlyPayments).where(eq(earlyPayments.id, a.id)))[0].status).toBe("cancelled");
    expect(b.status).toBe("proposed");
    const f = await w.financed();
    await expect(propose(f.invoiceId)).rejects.toThrow("only a confirmed invoice");
  });
});

describe("answering", () => {
  it("only the seller can answer; accepting withdraws the open offer and gives the buyer an account", async () => {
    const { invoiceId, offerId } = await w.offered();
    const p = await propose(invoiceId);
    await expect(respondEarlyPayment(w.db, { ...w.sellerActor, businessId: w.buyerId }, p.id, "accept", gw, T0)).rejects.toThrow("FORBIDDEN");
    const a = await respondEarlyPayment(w.db, w.sellerActor, p.id, "accept", gw, T0);
    expect(a.status).toBe("accepted");
    expect((await w.db.select().from(financingOffers).where(eq(financingOffers.id, offerId)))[0].status).toBe("rejected");
    expect(await accountOf(invoiceId)).toMatch(/^MARI/);
    await expect(respondEarlyPayment(w.db, w.sellerActor, p.id, "accept", gw, T0)).rejects.toThrow("proposal is accepted");
    await expect(generateOffer(w.db, invoiceId, gw, T0)).rejects.toThrow("accepted early payment");
  });
  it("declining leaves the invoice free for normal financing", async () => {
    const { invoiceId } = await w.offered();
    const p = await propose(invoiceId);
    await respondEarlyPayment(w.db, w.sellerActor, p.id, "decline", gw, T0);
    expect((await w.db.select().from(earlyPayments))[0].status).toBe("declined");
    expect((await w.db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0].status).toBe("eligible");
  });
  it("an unanswered proposal expires, and so does an accepted one that is never paid", async () => {
    const { invoiceId } = await w.offered();
    const p = await propose(invoiceId);
    const late = new Date(T0.getTime() + 73 * 3_600_000);
    await expect(respondEarlyPayment(w.db, w.sellerActor, p.id, "accept", gw, late)).rejects.toThrow("expired");
    const q = await propose(invoiceId, 1200, T0);
    await respondEarlyPayment(w.db, w.sellerActor, q.id, "accept", gw, T0);
    expect(await expireEarlyPayments(w.db, new Date(T0.getTime() + 4 * 86_400_000))).toBe(1);
    expect((await generateOffer(w.db, invoiceId, gw, T0, { replaceOpen: true })).unfunded).toBe(false); // financing resumes
  });
});

describe("the buyer pays", () => {
  async function accepted() {
    const { invoiceId } = await w.offered();
    const p = await propose(invoiceId);
    await respondEarlyPayment(w.db, w.sellerActor, p.id, "accept", gw, T0);
    return { invoiceId, p, account: await accountOf(invoiceId) };
  }
  it("books the fee, owes the seller the rest, pays it out, and closes the invoice", async () => {
    const { invoiceId, p, account } = await accepted();
    const r = await pay(account, p.netAmount, "UTR-EP1");
    expect(r).toMatchObject({ status: "applied", closed: true });
    expect((await w.db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0].status).toBe("paid");
    expect((await w.db.select().from(earlyPayments))[0].status).toBe("paid");
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(p.netAmount);
    expect(await balance(w.db, ACCOUNTS.sellerPayable(w.sellerId))).toBe(-(p.netAmount - p.feeAmount));
    expect(-(await balance(w.db, ACCOUNTS.feeIncome)) + -(await balance(w.db, ACCOUNTS.gstPayable))).toBe(p.feeAmount);
    expect((await w.db.select().from(sellerPayouts))[0]).toMatchObject({ amount: p.netAmount - p.feeAmount, status: "pending" });
    await runSurplusPayouts(w.db, gw);
    expect(await balance(w.db, ACCOUNTS.sellerPayable(w.sellerId))).toBe(0n);
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(p.feeAmount); // only the platform's fee is left in escrow
  });
  it("a replayed credit does nothing; a wrong amount goes to ops and the proposal stays open", async () => {
    const { p, account } = await accepted();
    expect((await pay(account, p.netAmount - 1n, "UTR-BAD")).status).toBe("unmatched");
    expect((await w.db.select().from(unmatchedCredits))[0].reason).toContain("exactly");
    expect((await w.db.select().from(earlyPayments))[0].status).toBe("accepted");
    await pay(account, p.netAmount, "UTR-OK");
    expect((await pay(account, p.netAmount, "UTR-OK")).status).toBe("replayed");
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(p.netAmount);
  });
});

it("defaults are sane", () => { expect(DD.minBps).toBeLessThan(DD.maxBps); });
