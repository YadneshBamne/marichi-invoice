// Invoice marketplace. Financiers fund an escrow balance, bid on approved invoices, and the seller picks a bid.
// Money model (all on the existing ledger, one pooled escrow account):
//   funding     Dr escrow            Cr financier_funds:<f>      capital in, free to deploy
//   disbursed   Dr financier_funds   Cr financier_deployed      (with the normal disbursement entry)
//   repayment   Dr financier_deployed  Cr financier_funds       principal back
//               Dr discount/penal income  Cr financier_funds    financier's share of what was collected
//   write-off   Dr financier_deployed  Cr receivable            the financier bears the loss
// The platform keeps `MARKET.platformShareBps` of collected discount and penal charges, plus the processing fee.
import { and, asc, desc, eq, inArray, notExists, or, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import {
  auditLog, bids, businesses, financierBuyerLimits, financingOffers, invoiceCollections, invoices, ledgerAccounts, ledgerEntries, ledgerTransactions,
  offerShares, tdsWithheld, underwritingDecisions, users,
} from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { assertNotFrozen } from "../fraud/service";
import { ACCOUNTS, balance, ensureAccounts } from "../ledger/accounts";
import { splitAmount, type Participant } from "./pool";
import { postEntry, type Line } from "../ledger/post";
import { describeOffer, priceOffer } from "../offers/pricing";
import { notifyBusiness } from "../notify";
import { assertNoEarlyPayment } from "../earlypay/service";
import { assertActiveFinancier, assertWithinMandate, exposureToBuyer } from "./financier";
import { ensureKeyFacts } from "../agreements/keyfacts";
import { formatMoney } from "../../lib/money";
import { market } from "../../lib/countries";

export const MARKET = {
  bidValidityHours: 48,
  minDiscountBps: 600, // 6% p.a.: a bid below this is not worth the platform's servicing cost
  maxDiscountBps: 3600, // 36% p.a.: the cap on what a seller can be charged
  platformShareBps: 2000, // share of collected discount and penal charges kept by the platform on financier-funded deals
};

const STAFF = ["ops", "admin"];
const dayOf = (d: Date | string) => Math.floor(new Date(d).getTime() / 86_400_000);
export type FinancierActor = { id: string; role: string; businessId: string | null };
export type SellerActor = { id: string; role: string; businessId: string | null };

/** Split a collected amount between the financier and the platform. The platform's part rounds up so the financier never gets more than it earned. */
export const financierShare = (amount: bigint) => amount - (amount * BigInt(MARKET.platformShareBps) + 9_999n) / 10_000n;

/**
 * Ledger legs for a repayment on a financier-funded invoice, added to the same entry as the normal repayment legs. Each financier behind
 * the offer gets its share of the principal, discount and penal charges; the platform keeps its part; and where tax is held back from a
 * financier's earnings (tdsBps) that part goes to the tax-payable account instead of its funds. `tds` lists what was held back, for the record.
 */
export function repaymentLegs(parts: Participant[], paid: { principal: bigint; discount: bigint; penal: bigint }): { lines: Line[]; tds: { financierId: string; base: bigint; rateBps: number; amount: bigint }[] } {
  const lines: Line[] = [];
  const tds: { financierId: string; base: bigint; rateBps: number; amount: bigint }[] = [];
  const shares = parts.map((p) => p.shareBps);
  const principal = splitAmount(paid.principal, shares), discount = splitAmount(paid.discount, shares), penal = splitAmount(paid.penal, shares);
  let held = 0n;
  parts.forEach((part, i) => {
    const dShare = financierShare(discount[i]), pShare = financierShare(penal[i]);
    const base = dShare + pShare;
    const tax = part.tdsBps > 0 ? (base * BigInt(part.tdsBps)) / 10_000n : 0n;
    const toFunds = principal[i] + base - tax;
    if (principal[i] > 0n) lines.push({ account: ACCOUNTS.financierDeployed(part.financierId), direction: "debit", amount: principal[i] });
    if (dShare > 0n) lines.push({ account: ACCOUNTS.discountIncome, direction: "debit", amount: dShare });
    if (pShare > 0n) lines.push({ account: ACCOUNTS.penalIncome, direction: "debit", amount: pShare });
    if (toFunds > 0n) lines.push({ account: ACCOUNTS.financierFunds(part.financierId), direction: "credit", amount: toFunds });
    if (tax > 0n) { held += tax; tds.push({ financierId: part.financierId, base, rateBps: part.tdsBps, amount: tax }); }
  });
  if (held > 0n) lines.push({ account: ACCOUNTS.tdsPayable, direction: "credit", amount: held });
  return { lines, tds };
}

const fundsOf = async (db: Database | Tx, financierId: string) => -(await balance(db, ACCOUNTS.financierFunds(financierId)));

/** Advances accepted but not yet paid out. They are spoken for, so they cannot be bid on twice or withdrawn. Counts this financier's part of a shared offer. */
async function reservedFor(db: Database | Tx, financierId: string) {
  const r = await db.execute(sql`
    select coalesce(sum(x.amt), 0)::text as v from (
      select o.advance_amount as amt from financing_offers o join invoices i on i.id = o.invoice_id
        where o.financier_id = ${financierId} and o.status = 'accepted' and i.status = 'eligible'
          and not exists (select 1 from offer_shares s where s.offer_id = o.id)
      union all
      select s.advance_amount from offer_shares s join financing_offers o on o.id = s.offer_id join invoices i on i.id = o.invoice_id
        where s.financier_id = ${financierId} and o.status = 'accepted' and i.status = 'eligible'
    ) x`);
  return BigInt((r as unknown as { rows: { v: string }[] }).rows[0].v);
}

/** What a financier has: cash in escrow, how much of it is promised to accepted deals, and how much is out in invoices. */
export async function position(db: Database | Tx, financierId: string) {
  const [funds, deployed, reserved] = await Promise.all([fundsOf(db, financierId), balance(db, ACCOUNTS.financierDeployed(financierId)).then((b) => -b), reservedFor(db, financierId)]);
  return { funds, deployed, reserved, available: funds - reserved };
}

/** Cash that belongs to the platform: escrow less everything owed to financiers. Platform-funded payouts must stay inside this. */
export async function platformCash(db: Database | Tx) {
  const r = await db.execute(sql`
    select coalesce(sum(case e.direction when 'debit' then e.amount else -e.amount end), 0)::text as bal
    from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.code like 'financier\\_funds:%'`);
  const owed = -BigInt((r as unknown as { rows: { bal: string }[] }).rows[0].bal);
  return (await balance(db, ACCOUNTS.escrow)) - owed;
}

async function mustBeFinancier(db: Database | Tx, financierId: string) {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, financierId));
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.businessId, financierId), eq(users.role, "financier"))).limit(1);
  if (!b || !u) throw new Error("not a financier");
  if (b.kybStatus !== "approved") throw new Error("the financier's verification is not approved yet");
  await assertActiveFinancier(db, financierId, null).catch((e) => { throw new Error(`the financier is not approved to hold funds: ${(e as Error).message}`); });
  return b;
}

/** Staff record a deposit that has landed in escrow. Idempotent on ref. */
export async function recordFunding(db: Database, p: { financierId: string; amount: bigint; ref: string; staffId: string; staffRole: string }) {
  if (!STAFF.includes(p.staffRole)) throw new Error("forbidden");
  if (p.amount <= 0n) throw new Error("amount must be positive");
  return db.transaction(async (tx) => {
    await mustBeFinancier(tx, p.financierId);
    await ensureAccounts(tx, [ACCOUNTS.escrow, ACCOUNTS.financierFunds(p.financierId)]);
    const r = await postEntry(tx, { ref: `ffund:${p.ref}`, type: "financier_funding", lines: [
      { account: ACCOUNTS.escrow, direction: "debit", amount: p.amount },
      { account: ACCOUNTS.financierFunds(p.financierId), direction: "credit", amount: p.amount },
    ] });
    if (!r.replayed) await tx.insert(auditLog).values({ actorId: p.staffId, action: "financier.fund", entity: "business", entityId: p.financierId, after: { amount: p.amount.toString(), ref: p.ref } });
    return r;
  });
}

/** Staff record a payout of unused funds back to the financier. Only what is not promised to an accepted deal can leave. */
export async function recordWithdrawal(db: Database, p: { financierId: string; amount: bigint; ref: string; staffId: string; staffRole: string }) {
  if (!STAFF.includes(p.staffRole)) throw new Error("forbidden");
  if (p.amount <= 0n) throw new Error("amount must be positive");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
    await mustBeFinancier(tx, p.financierId);
    if ((await position(tx, p.financierId)).available < p.amount) throw new Error("more than the financier has available");
    await ensureAccounts(tx, [ACCOUNTS.escrow, ACCOUNTS.financierFunds(p.financierId)]);
    const r = await postEntry(tx, { ref: `fwd:${p.ref}`, type: "financier_withdrawal", lines: [
      { account: ACCOUNTS.financierFunds(p.financierId), direction: "debit", amount: p.amount },
      { account: ACCOUNTS.escrow, direction: "credit", amount: p.amount },
    ] });
    if (!r.replayed) await tx.insert(auditLog).values({ actorId: p.staffId, action: "financier.withdraw", entity: "business", entityId: p.financierId, after: { amount: p.amount.toString(), ref: p.ref } });
    return r;
  });
}

/** Approved invoices still waiting for a financier, as a financier sees them: no seller identity until a bid is accepted. */
export async function dealFlow(db: Database, financierId: string, now = new Date()) {
  const rows = await db.select({ i: invoices, uw: underwritingDecisions, buyer: businesses.legalName }).from(invoices)
    .innerJoin(underwritingDecisions, eq(underwritingDecisions.invoiceId, invoices.id))
    .innerJoin(businesses, eq(businesses.id, invoices.buyerId))
    .where(and(
      eq(invoices.status, "eligible"), eq(invoices.disputeFlag, false), eq(underwritingDecisions.decision, "approved"),
      notExists(db.select({ x: sql`1` }).from(financingOffers).where(and(eq(financingOffers.invoiceId, invoices.id), eq(financingOffers.status, "accepted")))),
    )).orderBy(asc(invoices.dueDate));
  const mine = new Map((await db.select().from(bids).where(and(eq(bids.financierId, financierId), eq(bids.status, "open")))).map((b) => [b.invoiceId, b]));
  return rows.filter((r) => dayOf(r.i.dueDate) - dayOf(now) >= 1).map((r) => ({
    invoiceId: r.i.id, bundleId: r.i.bundleId, ref: r.i.id.slice(0, 8).toUpperCase(), amount: r.i.amount, dueDate: r.i.dueDate, tenorDays: dayOf(r.i.dueDate) - dayOf(now),
    buyer: r.buyer, grade: r.uw.riskGrade, maxAdvanceBps: r.uw.advanceRateBps, guideDiscountBps: r.uw.discountRateBps, myBid: mine.get(r.i.id) ?? null,
  }));
}

/** Place (or replace) a bid. The advance is capped by the grade's advance rate and by the financier's available funds. */
export async function placeBid(db: Database, actor: FinancierActor, p: { invoiceId: string; advanceBps: number; discountBps: number; shareBps?: number }, gw: Adapters = gateway, now = new Date()) {
  if (actor.role !== "financier" || !actor.businessId) throw new Error("FORBIDDEN");
  const fid = actor.businessId;
  const shareBps = p.shareBps ?? 10_000;
  if (!Number.isInteger(shareBps) || shareBps < 500 || shareBps > 10_000 || shareBps % 100 !== 0) throw new Error("the share of the advance you fund must be from 5% to 100%, in whole percents");
  if (!Number.isInteger(p.discountBps) || p.discountBps < MARKET.minDiscountBps || p.discountBps > MARKET.maxDiscountBps)
    throw new Error(`the discount must be between ${MARKET.minDiscountBps / 100}% and ${MARKET.maxDiscountBps / 100}% a year`);
  const out = await db.transaction((tx) => placeBidTx(tx, actor, p, now));
  await notifyBusiness(db, out.inv.sellerId, "bid_received", { invoiceNumber: out.inv.invoiceNumber, advance: formatMoney(out.bid.advanceAmount) }, gw);
  return out.bid;
}

/** The checks and the write for one bid, inside a transaction the caller owns, so that several bids can be placed together or not at all. */
export async function placeBidTx(tx: Tx, actor: FinancierActor, p: { invoiceId: string; advanceBps: number; discountBps: number; shareBps?: number }, now: Date) {
  const fid = actor.businessId!;
  const shareBps = p.shareBps ?? 10_000;
  await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
  await mustBeFinancier(tx, fid);
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId));
  if (!inv || inv.status !== "eligible" || inv.disputeFlag) throw new Error("this invoice is not open for bids");
  await assertNotFrozen(tx, inv.id);
  await assertNoEarlyPayment(tx, inv.id);
  const [uw] = await tx.select().from(underwritingDecisions).where(eq(underwritingDecisions.invoiceId, inv.id));
  if (uw?.decision !== "approved") throw new Error("this invoice is not open for bids");
  const [taken] = await tx.select({ id: financingOffers.id }).from(financingOffers).where(and(eq(financingOffers.invoiceId, inv.id), eq(financingOffers.status, "accepted")));
  if (taken) throw new Error("this invoice has already been funded");
  const tenorDays = dayOf(inv.dueDate) - dayOf(now);
  if (tenorDays < 1) throw new Error("this invoice is due; too late to bid");
  if (!Number.isInteger(p.advanceBps) || p.advanceBps <= 0 || p.advanceBps > uw.advanceRateBps) throw new Error(`the advance can be at most ${uw.advanceRateBps / 100}% of the invoice`);
  const full = priceOffer({ amount: inv.amount, advanceBps: p.advanceBps, discountBps: p.discountBps, tenorDays });
  // A part-bid prices the same offer and takes its share of every figure; it only becomes real when combined with others covering the rest.
  const price = shareBps === 10_000 ? full : { ...full, advanceAmount: (full.advanceAmount * BigInt(shareBps)) / 10_000n, feeAmount: (full.feeAmount * BigInt(shareBps)) / 10_000n, expectedDiscount: (full.expectedDiscount * BigInt(shareBps)) / 10_000n };
  const [seller] = await tx.select({ country: businesses.country, industry: businesses.industry }).from(businesses).where(eq(businesses.id, inv.sellerId));
  await assertActiveFinancier(tx, fid, seller?.country ?? market().code, now); // licensed where the seller is
  await assertWithinMandate(tx, fid, { buyerId: inv.buyerId, sellerId: inv.sellerId, grade: uw.riskGrade, advance: price.advanceAmount, tenorDays, industry: seller?.industry ?? null });
  if ((await position(tx, fid)).available < price.advanceAmount) throw new Error("you do not have enough available funds for this bid");
  await tx.update(bids).set({ status: "withdrawn", decidedAt: now }).where(and(eq(bids.invoiceId, inv.id), eq(bids.financierId, fid), eq(bids.status, "open")));
  const [bid] = await tx.insert(bids).values({
    invoiceId: inv.id, financierId: fid, advanceAmount: price.advanceAmount, discountBps: p.discountBps, feeAmount: price.feeAmount,
    expectedDiscount: price.expectedDiscount, shareBps, advanceBps: p.advanceBps, tenorDays, expiresAt: new Date(Math.min(now.getTime() + MARKET.bidValidityHours * 3_600_000, new Date(inv.dueDate).getTime())),
  }).returning();
  await tx.insert(auditLog).values({ actorId: actor.id, action: "bid.place", entity: "invoice", entityId: inv.id, after: { bidId: bid.id, advance: price.advanceAmount.toString(), discountBps: p.discountBps } });
  return { bid, inv };
}

export async function withdrawBid(db: Database, actor: FinancierActor, bidId: string, now = new Date()) {
  if (actor.role !== "financier" || !actor.businessId) throw new Error("FORBIDDEN");
  const [b] = await db.update(bids).set({ status: "withdrawn", decidedAt: now })
    .where(and(eq(bids.id, bidId), eq(bids.financierId, actor.businessId), eq(bids.status, "open"))).returning();
  if (!b) throw new Error("that bid is no longer open");
  await db.insert(auditLog).values({ actorId: actor.id, action: "bid.withdraw", entity: "invoice", entityId: b.invoiceId, after: { bidId } });
}

/** Open, unexpired bids on these invoices, cheapest for the seller first (lowest all-in rate). */
export async function bidsFor(db: Database, invoiceIds: string[], now = new Date()) {
  if (!invoiceIds.length) return new Map<string, (typeof bids.$inferSelect & { netDisbursal: bigint; effectiveAprBps: number })[]>();
  const rows = await db.select().from(bids).where(and(inArray(bids.invoiceId, invoiceIds), eq(bids.status, "open")));
  const out = new Map<string, (typeof rows[number] & { netDisbursal: bigint; effectiveAprBps: number })[]>();
  for (const b of rows) {
    if (b.expiresAt <= now) continue;
    const list = out.get(b.invoiceId) ?? [];
    list.push({ ...b, ...describeOffer(b) });
    out.set(b.invoiceId, list);
  }
  for (const l of out.values()) l.sort((a, b) => a.effectiveAprBps - b.effectiveAprBps || Number(b.netDisbursal - a.netDisbursal));
  return out;
}

/** The seller picks a bid. It becomes the accepted offer (replacing any open platform offer); every other bid on the invoice is closed. */
export async function acceptBid(db: Database, bidId: string, actor: SellerActor, gw: Adapters = gateway, now = new Date()) {
  const out = await db.transaction((tx) => acceptBidTx(tx, bidId, actor, now));
  if (!out) throw new Error("bid has expired");
  await ensureKeyFacts(db, out.offer.id, now).catch((e) => console.error("[keyfacts]", (e as Error).message));
  await notifyBusiness(db, out.bid.financierId, "bid_accepted", { invoiceNumber: out.inv.invoiceNumber, advance: formatMoney(out.bid.advanceAmount) }, gw);
  return out.offer;
}

/** The checks and the write for accepting one bid, inside a transaction the caller owns. Null when the bid had run out of time. */
export async function acceptBidTx(tx: Tx, bidId: string, actor: SellerActor, now: Date, viaBundle = false) {
  await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
  const [bid] = await tx.select().from(bids).where(eq(bids.id, bidId)).for("update");
  if (!bid) throw new Error("bid not found");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, bid.invoiceId));
  if (actor.role !== "seller" || actor.businessId !== inv.sellerId) throw new Error("FORBIDDEN");
  if (bid.status !== "open") throw new Error(`bid is ${bid.status}`);
  if (bid.shareBps < 10_000) throw new Error("this bid funds only part of the invoice. Combine it with others that cover the rest");
  if (inv.bundleId && !viaBundle) throw new Error("this invoice is in a bundle. Take a financier's bids on the bundle, or take the bundle apart first");
  if (bid.expiresAt <= now) {
    await tx.update(bids).set({ status: "expired", decidedAt: now }).where(eq(bids.id, bid.id));
    return null;
  }
  if (inv.status !== "eligible" || inv.disputeFlag) throw new Error("invoice is no longer eligible for financing");
  await assertNotFrozen(tx, inv.id);
  await assertNoEarlyPayment(tx, inv.id);
  const [live] = await tx.select().from(financingOffers).where(and(eq(financingOffers.invoiceId, inv.id), inArray(financingOffers.status, ["open", "accepted"])));
  if (live?.status === "accepted") throw new Error("this invoice has already been funded");
  const [seller] = await tx.select({ country: businesses.country }).from(businesses).where(eq(businesses.id, inv.sellerId));
  await assertActiveFinancier(tx, bid.financierId, seller?.country ?? market().code, now).catch(() => { throw new Error("that financier can no longer fund this invoice; choose another"); });
  const [lim] = await tx.select().from(financierBuyerLimits).where(and(eq(financierBuyerLimits.financierId, bid.financierId), eq(financierBuyerLimits.buyerId, inv.buyerId)));
  if (!lim || lim.status !== "active" || (await exposureToBuyer(tx, bid.financierId, inv.buyerId)) + bid.advanceAmount > lim.limit) throw new Error("that financier's limit on this buyer no longer covers this bid; choose another");
  if ((await position(tx, bid.financierId)).available < bid.advanceAmount) throw new Error("that financier no longer has the funds for this bid; choose another");
  if (live) await tx.update(financingOffers).set({ status: "rejected" }).where(eq(financingOffers.id, live.id));
  const [offer] = await tx.insert(financingOffers).values({
    invoiceId: inv.id, financierId: bid.financierId, advanceAmount: bid.advanceAmount, discountBps: bid.discountBps, feeAmount: bid.feeAmount,
    tenorDays: bid.tenorDays, expectedDiscount: bid.expectedDiscount, recourse: true, status: "accepted", expiresAt: now, acceptedAt: now, acceptedBy: actor.id,
  }).returning();
  await tx.update(bids).set({ status: "accepted", decidedAt: now }).where(eq(bids.id, bid.id));
  await tx.update(bids).set({ status: "rejected", decidedAt: now }).where(and(eq(bids.invoiceId, inv.id), eq(bids.status, "open")));
  await tx.insert(auditLog).values({ actorId: actor.id, action: "bid.accept", entity: "invoice", entityId: inv.id, after: { bidId, offerId: offer.id, financierId: bid.financierId } });
  return { offer, bid, inv };
}

/**
 * The seller combines several financiers' bids on one invoice, so together they fund it. The bids must add up to the whole advance (their
 * shares make 100%), offer the same advance rate, and each financier must still be allowed and able to fund its part. They become ONE offer
 * to the seller at the blended discount; the largest share leads. Everything is checked and written together or not at all.
 */
export async function acceptBids(db: Database, bidIds: string[], actor: SellerActor, gw: Adapters = gateway, now = new Date()) {
  const ids = [...new Set(bidIds)];
  if (ids.length < 2) throw new Error("choose two or more bids to combine; to take a single bid, accept it");
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
    const chosen = await tx.select().from(bids).where(inArray(bids.id, ids)).for("update");
    if (chosen.length !== ids.length) throw new Error("bid not found");
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, chosen[0].invoiceId));
    if (chosen.some((b) => b.invoiceId !== inv.id)) throw new Error("the bids must all be on the same invoice");
    if (actor.role !== "seller" || actor.businessId !== inv.sellerId) throw new Error("FORBIDDEN");
    if (inv.bundleId) throw new Error("this invoice is in a bundle. Take a financier's bids on the bundle, or take the bundle apart first");
if (new Set(chosen.map((b) => b.financierId)).size !== chosen.length) throw new Error("each financier can take part once");
    for (const b of chosen) {
      if (b.status !== "open") throw new Error(`a chosen bid is ${b.status}`);
      if (b.expiresAt <= now) throw new Error("a chosen bid has expired; choose again");
    }
    if (chosen.reduce((a, b) => a + b.shareBps, 0) !== 10_000) throw new Error("the chosen bids must together fund the whole advance (their shares must add up to 100%)");
    if (new Set(chosen.map((b) => b.advanceBps)).size !== 1 || chosen[0].advanceBps === null) throw new Error("the chosen bids must offer the same advance rate");
    if (inv.status !== "eligible" || inv.disputeFlag) throw new Error("invoice is no longer eligible for financing");
    await assertNotFrozen(tx, inv.id);
    await assertNoEarlyPayment(tx, inv.id);
    const [live] = await tx.select().from(financingOffers).where(and(eq(financingOffers.invoiceId, inv.id), inArray(financingOffers.status, ["open", "accepted"])));
    if (live?.status === "accepted") throw new Error("this invoice has already been funded");
    const [seller] = await tx.select({ country: businesses.country }).from(businesses).where(eq(businesses.id, inv.sellerId));
    for (const b of chosen) {
      await assertActiveFinancier(tx, b.financierId, seller?.country ?? market().code, now).catch(() => { throw new Error("one of the financiers can no longer fund this invoice; choose again"); });
      const [lim] = await tx.select().from(financierBuyerLimits).where(and(eq(financierBuyerLimits.financierId, b.financierId), eq(financierBuyerLimits.buyerId, inv.buyerId)));
      if (!lim || lim.status !== "active" || (await exposureToBuyer(tx, b.financierId, inv.buyerId)) + b.advanceAmount > lim.limit) throw new Error("one of the financiers' limit on this buyer no longer covers its part; choose again");
      if ((await position(tx, b.financierId)).available < b.advanceAmount) throw new Error("one of the financiers no longer has the funds for its part; choose again");
    }
    if (live) await tx.update(financingOffers).set({ status: "rejected" }).where(eq(financingOffers.id, live.id));
    const ordered = [...chosen].sort((a, b) => b.shareBps - a.shareBps || a.createdAt.getTime() - b.createdAt.getTime()); // the lead first
    const advance = ordered.reduce((a, b) => a + b.advanceAmount, 0n);
    const blended = Number(ordered.reduce((a, b) => a + BigInt(b.discountBps) * b.advanceAmount, 0n) / advance); // weighted by what each funds
    const [offer] = await tx.insert(financingOffers).values({
      invoiceId: inv.id, financierId: ordered[0].financierId, advanceAmount: advance, discountBps: blended, feeAmount: ordered.reduce((a, b) => a + b.feeAmount, 0n),
      tenorDays: dayOf(inv.dueDate) - dayOf(now), expectedDiscount: ordered.reduce((a, b) => a + b.expectedDiscount, 0n), recourse: true, status: "accepted", expiresAt: now, acceptedAt: now, acceptedBy: actor.id,
    }).returning();
    for (const b of ordered) await tx.insert(offerShares).values({ offerId: offer.id, financierId: b.financierId, shareBps: b.shareBps, advanceAmount: b.advanceAmount, discountBps: b.discountBps });
    await tx.update(bids).set({ status: "accepted", decidedAt: now }).where(inArray(bids.id, ids));
    await tx.update(bids).set({ status: "rejected", decidedAt: now }).where(and(eq(bids.invoiceId, inv.id), eq(bids.status, "open")));
    await tx.insert(auditLog).values({ actorId: actor.id, action: "bid.accept_group", entity: "invoice", entityId: inv.id, after: { offerId: offer.id, financiers: ordered.map((b) => ({ id: b.financierId, shareBps: b.shareBps })) } });
    return { offer, chosen: ordered, inv };
  });
  await ensureKeyFacts(db, out.offer.id, now).catch((e) => console.error("[keyfacts]", (e as Error).message));
  for (const b of out.chosen) await notifyBusiness(db, b.financierId, "bid_accepted", { invoiceNumber: out.inv.invoiceNumber, advance: formatMoney(b.advanceAmount) }, gw);
  return out.offer;
}

/** Worker: close bids that ran out of time. */
export async function expireBids(db: Database, now = new Date()) {
  const r = await db.update(bids).set({ status: "expired", decidedAt: now }).where(and(eq(bids.status, "open"), sql`${bids.expiresAt} <= ${now}`)).returning({ id: bids.id });
  return r.length;
}

/** The financier's book: every invoice they funded, with what is still owed and the state it is in. */
export async function portfolio(db: Database, financierId: string, now = new Date()) {
  const rows = await db.select({ o: financingOffers, i: invoices, c: invoiceCollections, buyer: businesses.legalName }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .innerJoin(businesses, eq(businesses.id, invoices.buyerId))
    .leftJoin(invoiceCollections, eq(invoiceCollections.invoiceId, invoices.id))
    .where(and(eq(financingOffers.status, "accepted"), or(
      eq(financingOffers.financierId, financierId),
      sql`exists (select 1 from offer_shares s where s.offer_id = ${financingOffers.id} and s.financier_id = ${financierId})`,
    ))).orderBy(desc(financingOffers.acceptedAt));
  const shared = rows.length ? await db.select().from(offerShares).where(inArray(offerShares.offerId, rows.map((r) => r.o.id))) : [];
  return rows.map((r) => {
    // a shared offer lists its financiers lead first; a single-financier offer is 100% its financier
    const mine = shared.filter((s) => s.offerId === r.o.id).sort((a, b) => b.shareBps - a.shareBps || a.createdAt.getTime() - b.createdAt.getTime());
    const bps = mine.length ? mine.map((s) => s.shareBps) : [10_000];
    const at = mine.length ? mine.findIndex((s) => s.financierId === financierId) : 0;
    const part = (v: bigint) => splitAmount(v, bps)[at];
    return {
      invoiceId: r.i.id, invoiceNumber: r.i.invoiceNumber, buyer: r.buyer, status: r.i.status, dueDate: r.i.dueDate,
      advance: mine.length ? mine[at].advanceAmount : r.o.advanceAmount, discountBps: mine.length ? mine[at].discountBps : r.o.discountBps, expectedDiscount: part(r.o.expectedDiscount),
      outstandingPrincipal: part(r.c?.principal ?? 0n), accruedDiscount: part(r.c?.discount ?? 0n), penal: part(r.c?.penal ?? 0n),
      dpd: Math.max(0, dayOf(now) - dayOf(r.i.dueDate)), sharedWith: mine.length > 1 ? mine.length - 1 : 0, shareBps: bps[at],
    };
  });
}

/** Every movement on the financier's funds account, oldest first, with a running balance. Built straight from the ledger. */
export async function statement(db: Database, financierId: string) {
  const rows = await db.select({ at: ledgerTransactions.createdAt, ref: ledgerTransactions.ref, type: ledgerTransactions.type, dir: ledgerEntries.direction, amount: ledgerEntries.amount })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(eq(ledgerAccounts.code, ACCOUNTS.financierFunds(financierId))).orderBy(asc(ledgerTransactions.createdAt), asc(ledgerTransactions.id));
  const label: Record<string, string> = { financier_funding: "Funds added", financier_withdrawal: "Funds withdrawn", deploy: "Deployed into an invoice", repayment: "Repayment received (principal and your share of discount)" };
  let running = 0n;
  return rows.map((r) => {
    const delta = r.dir === "credit" ? r.amount : -r.amount;
    running += delta;
    return { at: r.at, ref: r.ref, label: label[r.type] ?? r.type, delta, running };
  });
}

/** Totals for the dashboard: how much has come back, and what it earned beyond the principal. */
export async function earnings(db: Database, financierId: string) {
  const s = await statement(db, financierId);
  const returned = s.filter((r) => r.label.startsWith("Repayment")).reduce((a, r) => a + r.delta, 0n);
  // Principal that came back is what left the "deployed" account at repayment, read straight from the ledger so a shared offer is exact.
  const r = await db.execute(sql`
    select coalesce(sum(e.amount), 0)::text as v
    from ledger_entries e join ledger_accounts a on a.id = e.account_id join ledger_transactions t on t.id = e.transaction_id
    where a.code = ${ACCOUNTS.financierDeployed(financierId)} and t.type = 'repayment' and e.direction = 'debit'`);
  const v = (r as unknown as { rows: { v: string }[] }).rows[0].v;
  return { returned, earned: returned - BigInt(v) };
}

/** Tax held back from this financier's earnings so far, for its statement. */
export async function taxHeld(db: Database, financierId: string) {
  const [r] = await db.select({ v: sql<string>`coalesce(sum(${tdsWithheld.amount}), 0)` }).from(tdsWithheld).where(eq(tdsWithheld.financierId, financierId));
  return BigInt(r.v);
}
