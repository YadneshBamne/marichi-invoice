import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agreements, bids, notifications, offerShares, repayments, tdsWithheld, virtualAccounts } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { prepareAgreements, signInApp } from "../agreements/service";
import { executeDisbursement, requestDisbursement } from "../disbursements/service";
import { recordIncomingPayment, writeOff } from "../collections/service";
import { ACCOUNTS, balance } from "../ledger/accounts";
import { acceptBid, acceptBids, financierShare, placeBid, portfolio, position, taxHeld, earnings } from "./service";
import { exposureToBuyer } from "./financier";
import { splitAmount } from "./pool";
import { recordTdsRemittance, setFinancierTds, taxPayable, tdsReport } from "../tax/tds";
import { forecast } from "../analytics/service";

let w: Awaited<ReturnType<typeof world>>;
const L = 1_00_000_00n;
const staff = { id: "00000000-0000-0000-0000-0000000000a2", role: "admin" };
beforeEach(async () => { w = await world(); });

type Fin = Awaited<ReturnType<typeof w.financier>>;
const part = (f: Fin, invoiceId: string, shareBps: number, discountBps = 1000, advanceBps = 9000) =>
  placeBid(w.db, f.actor, { invoiceId, advanceBps, discountBps, shareBps }, gw, T0);

/** Two financiers, an invoice of 10 lakh, and their part-bids (60% and 40% of a 9 lakh advance). */
async function twoBids(fund = 50n * L) {
  const a = await w.financier("Alpha Capital", fund), b = await w.financier("Beta Finance", fund);
  const { invoiceId } = await w.offered();
  const ba = await part(a, invoiceId, 6000, 1000), bb = await part(b, invoiceId, 4000, 1400);
  return { a, b, invoiceId, ba, bb };
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

describe("splitting money between financiers", () => {
  it("each part rounds down and the lead takes the remainder, so the parts always add up", () => {
    expect(splitAmount(1000n, [6000, 4000])).toEqual([600n, 400n]);
    expect(splitAmount(1001n, [6000, 4000])).toEqual([601n, 400n]);
    const parts = splitAmount(999_999_999n, [3333, 3333, 3334]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(999_999_999n);
    expect(splitAmount(7n, [10_000])).toEqual([7n]);
  });
});

describe("part-bids", () => {
  it("fund a share of every figure, only whole percents from 5 to 100, and cannot be taken on their own", async () => {
    const a = await w.financier("Alpha", 50n * L);
    const { invoiceId } = await w.offered();
    await expect(part(a, invoiceId, 400)).rejects.toThrow(/5% to 100%/);
    await expect(part(a, invoiceId, 6050)).rejects.toThrow(/whole percents/);
    const full = await placeBid(w.db, a.actor, { invoiceId, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    const half = await part(a, invoiceId, 5000, 1000); // replaces its own earlier bid
    expect(half.advanceAmount).toBe(full.advanceAmount / 2n);
    expect(half.feeAmount).toBe(full.feeAmount / 2n);
    expect(half).toMatchObject({ shareBps: 5000, advanceBps: 9000 });
    await expect(acceptBid(w.db, half.id, w.sellerActor, gw, T0)).rejects.toThrow(/only part of the invoice/);
  });
});

describe("combining bids", () => {
  it("becomes one offer at the blended rate, led by the largest share, with every financier named and told", async () => {
    const { a, b, invoiceId, ba, bb } = await twoBids();
    const offer = await acceptBids(w.db, [ba.id, bb.id], w.sellerActor, gw, T0);
    expect(offer).toMatchObject({ status: "accepted", financierId: a.id, advanceAmount: 9n * L, discountBps: 1160 }); // 60% at 10% and 40% at 14%
    const shares = await w.db.select().from(offerShares).where(eq(offerShares.offerId, offer.id));
    expect(shares.map((s) => [s.financierId, s.shareBps, s.advanceAmount]).sort()).toEqual([[a.id, 6000, 540_000_00n], [b.id, 4000, 360_000_00n]].sort());
    expect((await w.db.select().from(bids).where(eq(bids.invoiceId, invoiceId))).map((x) => x.status)).toEqual(["accepted", "accepted"]);
    expect((await w.db.select().from(notifications)).filter((n) => n.template === "bid_accepted")).toHaveLength(2);
    const kf = (await w.db.select().from(agreements).where(eq(agreements.offerId, offer.id))).find((x) => x.kind === "key_facts");
    expect(kf).toBeTruthy(); // made with the offer
    expect(await position(w.db, a.id)).toMatchObject({ reserved: 540_000_00n });
    expect(await position(w.db, b.id)).toMatchObject({ reserved: 360_000_00n });
    expect(await exposureToBuyer(w.db, a.id, w.buyerId)).toBe(540_000_00n);
    expect(await exposureToBuyer(w.db, b.id, w.buyerId)).toBe(360_000_00n);
  });

  it("is refused unless the shares make the whole, the advance rate agrees, and each financier can still fund its part", async () => {
    const { a, b, ba, bb, invoiceId } = await twoBids();
    await expect(acceptBids(w.db, [ba.id], w.sellerActor, gw, T0)).rejects.toThrow(/two or more/);
    await expect(acceptBids(w.db, [ba.id, ba.id], w.sellerActor, gw, T0)).rejects.toThrow(/two or more/);
    const c = await w.financier("Gamma", 50n * L);
    const bc = await part(c, invoiceId, 2000, 1000);
    await expect(acceptBids(w.db, [ba.id, bc.id], w.sellerActor, gw, T0)).rejects.toThrow(/add up to 100%/); // 60 + 20
    const odd = await part(b, invoiceId, 4000, 1400, 8000); // replaces Beta's bid with a different advance
    await expect(acceptBids(w.db, [ba.id, odd.id], w.sellerActor, gw, T0)).rejects.toThrow(/same advance rate/);
    await expect(acceptBids(w.db, [ba.id, bb.id], w.sellerActor, gw, T0)).rejects.toThrow(/is withdrawn/); // Beta's first bid was replaced
    await expect(acceptBids(w.db, [ba.id, odd.id], { ...w.sellerActor, role: "buyer", businessId: w.buyerId }, gw, T0)).rejects.toThrow(/FORBIDDEN/);
    void a;
  });

  it("is refused when a financier's funds or buyer limit no longer cover its part", async () => {
    const { a, ba, bb } = await twoBids();
    // Alpha spends its money elsewhere before the seller decides
    const other = await w.offered();
    await placeBid(w.db, a.actor, { invoiceId: other.invoiceId, advanceBps: 9000, discountBps: 1000 }, gw, T0).then((x) => acceptBid(w.db, x.id, w.sellerActor, gw, T0));
    const { financierBuyerLimits } = await import("../db/schema");
    await w.db.update(financierBuyerLimits).set({ limit: 1n * L }).where(eq(financierBuyerLimits.financierId, a.id));
    await expect(acceptBids(w.db, [ba.id, bb.id], w.sellerActor, gw, T0)).rejects.toThrow(/limit on this buyer no longer covers/);
  });
});

describe("a shared offer in the money flow", () => {
  async function shared() {
    const t = await twoBids();
    const offer = await acceptBids(w.db, [t.ba.id, t.bb.id], w.sellerActor, gw, T0);
    await payOut(offer.id);
    return { ...t, offer };
  }

  it("each financier's own capital goes out, and the platform's escrow is untouched by either", async () => {
    const { a, b } = await shared();
    expect(await position(w.db, a.id)).toMatchObject({ funds: 50n * L - 540_000_00n, deployed: 540_000_00n });
    expect(await position(w.db, b.id)).toMatchObject({ funds: 50n * L - 360_000_00n, deployed: 360_000_00n });
    expect((await portfolio(w.db, a.id, T0))[0]).toMatchObject({ advance: 540_000_00n, outstandingPrincipal: 540_000_00n, shareBps: 6000, sharedWith: 1 });
    expect((await portfolio(w.db, b.id, T0))[0]).toMatchObject({ advance: 360_000_00n, outstandingPrincipal: 360_000_00n, shareBps: 4000 });
  });

  it("repayment gives each its principal and its share of the discount, and the ledger balances to the unit", async () => {
    const { a, b, invoiceId } = await shared();
    expect(await payDay(await accountOf(invoiceId), 10n * L, "UTR-P1")).toMatchObject({ status: "applied", closed: true });
    const [rep] = await w.db.select().from(repayments).where(eq(repayments.invoiceId, invoiceId));
    const alloc = rep.allocation as { principal: string; discount: string };
    const disc = splitAmount(BigInt(alloc.discount), [6000, 4000]);
    expect(await position(w.db, a.id)).toMatchObject({ funds: 50n * L + financierShare(disc[0]), deployed: 0n });
    expect(await position(w.db, b.id)).toMatchObject({ funds: 50n * L + financierShare(disc[1]), deployed: 0n });
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBe(-(BigInt(alloc.discount) - financierShare(disc[0]) - financierShare(disc[1])));
    expect((await earnings(w.db, a.id)).earned).toBe(financierShare(disc[0]));
    expect((await earnings(w.db, b.id)).earned).toBe(financierShare(disc[1]));
  });

  it("a write-off is shared: each financier bears its own part of the loss", async () => {
    const { a, b, invoiceId } = await shared();
    await writeOff(w.db, invoiceId, staff, "gone", new Date("2027-03-01T00:00:00Z"));
    expect(await balance(w.db, ACCOUNTS.creditLoss)).toBe(0n);
    expect(await position(w.db, a.id)).toMatchObject({ funds: 50n * L - 540_000_00n, deployed: 0n });
    expect(await position(w.db, b.id)).toMatchObject({ funds: 50n * L - 360_000_00n, deployed: 0n });
  });

  it("the payout is refused if ANY financier behind the offer is no longer allowed to fund, not only the lead", async () => {
    const t = await twoBids();
    const offer = await acceptBids(w.db, [t.ba.id, t.bb.id], w.sellerActor, gw, T0);
    await prepareAgreements(w.db, offer.id, gw, T0);
    await signInApp(w.db, { offerId: offer.id, actor: w.sellerActor }, T0);
    const d = await requestDisbursement(w.db, offer.id);
    const { financierProfiles } = await import("../db/schema");
    await w.db.update(financierProfiles).set({ status: "suspended" }).where(eq(financierProfiles.businessId, t.b.id)); // Beta, the smaller share
    await expect(executeDisbursement(w.db, d.id, gw, T0)).rejects.toThrow(/FINANCIER_NOT_ACTIVE/);
    expect((await position(w.db, t.a.id)).funds).toBe(50n * L); // nothing left Alpha's account either
  });

  it("each financier's forecast shows its own part", async () => {
    const { a, b } = await shared();
    const fa = await forecast(w.db, { role: "financier", businessId: a.id }, T0);
    const fb = await forecast(w.db, { role: "financier", businessId: b.id }, T0);
    const total = (f: Awaited<ReturnType<typeof forecast>>) => f.weeks.reduce((s, x) => s + x.values["Principal back"], 0n) + f.overdue["Principal back"];
    expect(total(fa)).toBe(540_000_00n);
    expect(total(fb)).toBe(360_000_00n);
  });
});

describe("tax held back from a financier's earnings", () => {
  async function single(tds?: number) {
    const f = await w.financier("Capital One", 50n * L);
    if (tds !== undefined) await setFinancierTds(w.db, staff, f.id, tds, "resident, no exemption certificate");
    const { invoiceId } = await w.offered();
    const offer = await acceptBid(w.db, (await placeBid(w.db, f.actor, { invoiceId, advanceBps: 9000, discountBps: 1000 }, gw, T0)).id, w.sellerActor, gw, T0);
    await payOut(offer.id);
    await payDay(await accountOf(invoiceId), 10n * L, "UTR-T1");
    const [rep] = await w.db.select().from(repayments).where(eq(repayments.invoiceId, invoiceId));
    return { f, invoiceId, offer, discount: BigInt((rep.allocation as { discount: string }).discount) };
  }

  it("with no rate set nothing is held back", async () => {
    const { f, discount } = await single();
    expect((await position(w.db, f.id)).funds).toBe(50n * L + financierShare(discount));
    expect(await taxPayable(w.db)).toBe(0n);
    expect(await taxHeld(w.db, f.id)).toBe(0n);
  });

  it("with a rate set, that share of the earnings goes to the tax account instead of the financier, and is recorded", async () => {
    const { f, invoiceId, discount } = await single(1000);
    const base = financierShare(discount), tax = (base * 1000n) / 10_000n;
    expect(tax).toBeGreaterThan(0n);
    expect((await position(w.db, f.id)).funds).toBe(50n * L + base - tax);
    expect(await taxPayable(w.db)).toBe(tax);
    expect(await taxHeld(w.db, f.id)).toBe(tax);
    expect((await w.db.select().from(tdsWithheld))[0]).toMatchObject({ financierId: f.id, invoiceId, base, rateBps: 1000, amount: tax });
    expect((await earnings(w.db, f.id)).earned).toBe(base - tax); // earnings are net of the tax
    const rows = await tdsReport(w.db, new Date("2026-01-01"), new Date("2027-12-31"));
    expect(rows).toMatchObject([{ financierId: f.id, base, amount: tax, n: 1 }]);
  });

  it("only one of two financiers is charged when only one has a rate, each on its own part", async () => {
    const { a, b, invoiceId, ba, bb } = await twoBids();
    await setFinancierTds(w.db, staff, b.id, 1500, "withholding applies");
    const offer = await acceptBids(w.db, [ba.id, bb.id], w.sellerActor, gw, T0);
    await payOut(offer.id);
    await payDay(await accountOf(invoiceId), 10n * L, "UTR-T2");
    const [rep] = await w.db.select().from(repayments).where(eq(repayments.invoiceId, invoiceId));
    const disc = splitAmount(BigInt((rep.allocation as { discount: string }).discount), [6000, 4000]);
    const baseB = financierShare(disc[1]), taxB = (baseB * 1500n) / 10_000n;
    expect((await position(w.db, a.id)).funds).toBe(50n * L + financierShare(disc[0]));
    expect((await position(w.db, b.id)).funds).toBe(50n * L + baseB - taxB);
    expect(await taxPayable(w.db)).toBe(taxB);
    expect(await taxHeld(w.db, a.id)).toBe(0n);
  });

  it("only staff set a rate, between 0 and 40%, with a reason; clearing it stops the deduction", async () => {
    const f = await w.financier("Capital One");
    await expect(setFinancierTds(w.db, { ...staff, role: "seller" }, f.id, 1000, "reason here")).rejects.toThrow(/forbidden/);
    await expect(setFinancierTds(w.db, staff, f.id, 4100, "reason here")).rejects.toThrow(/0% to 40%/);
    await expect(setFinancierTds(w.db, staff, f.id, 1000, "no")).rejects.toThrow(/say why/);
    await expect(setFinancierTds(w.db, staff, w.sellerId, 1000, "reason here")).rejects.toThrow(/no financier application/);
    await setFinancierTds(w.db, staff, f.id, 1000, "resident individual");
    await setFinancierTds(w.db, staff, f.id, null, "exemption certificate received");
    const { financierProfiles } = await import("../db/schema");
    expect((await w.db.select().from(financierProfiles).where(eq(financierProfiles.businessId, f.id)))[0].tdsBps).toBeNull();
  });

  it("paying the tax over to the authority leaves escrow and clears the payable; only what is owed can be paid, and a repeated reference is not paid twice", async () => {
    const { discount } = await single(1000);
    const owed = (financierShare(discount) * 1000n) / 10_000n;
    await expect(recordTdsRemittance(w.db, staff, { amount: owed + 1n, ref: "CHL-1" })).rejects.toThrow(/more than is owed/);
    await expect(recordTdsRemittance(w.db, { ...staff, role: "seller" }, { amount: owed, ref: "CHL-1" })).rejects.toThrow(/forbidden/);
    const escrowBefore = await balance(w.db, ACCOUNTS.escrow);
    await recordTdsRemittance(w.db, staff, { amount: owed, ref: "CHL-1" });
    await recordTdsRemittance(w.db, staff, { amount: owed, ref: "CHL-1" }).catch(() => {}); // the same reference replays harmlessly or is refused: never paid twice
    expect(await taxPayable(w.db)).toBe(0n);
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(escrowBefore - owed);
  });
});
