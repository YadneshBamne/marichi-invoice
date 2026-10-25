// Invoice marketplace. Financiers fund an escrow balance, bid on approved invoices, and the seller picks a bid.
// Money model (all on the existing ledger, one pooled escrow account):
//   funding     Dr escrow            Cr financier_funds:<f>      capital in, free to deploy
//   disbursed   Dr financier_funds   Cr financier_deployed      (with the normal disbursement entry)
//   repayment   Dr financier_deployed  Cr financier_funds       principal back
//               Dr discount/penal income  Cr financier_funds    financier's share of what was collected
//   write-off   Dr financier_deployed  Cr receivable            the financier bears the loss
// The platform keeps `MARKET.platformShareBps` of collected discount and penal charges, plus the processing fee.
import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import {
  auditLog, bids, businesses, financierBuyerLimits, financingOffers, invoiceCollections, invoices, ledgerAccounts, ledgerEntries, ledgerTransactions,
  underwritingDecisions, users,
} from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { assertNotFrozen } from "../fraud/service";
import { ACCOUNTS, balance, ensureAccounts } from "../ledger/accounts";
import { postEntry, type Line } from "../ledger/post";
import { describeOffer, priceOffer } from "../offers/pricing";
import { notifyBusiness } from "../notify";
import { assertNoEarlyPayment } from "../earlypay/service";
import { assertActiveFinancier, assertWithinMandate, exposureToBuyer } from "./financier";
import { formatINR } from "../../lib/money";

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

/** Ledger legs for a repayment on a financier-funded invoice. Added to the same entry as the normal repayment legs. */
export function repaymentLegs(financierId: string, paid: { principal: bigint; discount: bigint; penal: bigint }): Line[] {
  const lines: Line[] = [];
  const toFunds = paid.principal + financierShare(paid.discount) + financierShare(paid.penal);
  if (paid.principal > 0n) lines.push({ account: ACCOUNTS.financierDeployed(financierId), direction: "debit", amount: paid.principal });
  if (financierShare(paid.discount) > 0n) lines.push({ account: ACCOUNTS.discountIncome, direction: "debit", amount: financierShare(paid.discount) });
  if (financierShare(paid.penal) > 0n) lines.push({ account: ACCOUNTS.penalIncome, direction: "debit", amount: financierShare(paid.penal) });
  if (toFunds > 0n) lines.push({ account: ACCOUNTS.financierFunds(financierId), direction: "credit", amount: toFunds });
  return lines;
}

const fundsOf = async (db: Database | Tx, financierId: string) => -(await balance(db, ACCOUNTS.financierFunds(financierId)));

/** Advances accepted but not yet paid out. They are spoken for, so they cannot be bid on twice or withdrawn. */
async function reservedFor(db: Database | Tx, financierId: string) {
  const [r] = await db.select({ v: sql<string>`coalesce(sum(${financingOffers.advanceAmount}), 0)` }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(financingOffers.financierId, financierId), eq(financingOffers.status, "accepted"), eq(invoices.status, "eligible")));
  return BigInt(r.v);
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
    invoiceId: r.i.id, ref: r.i.id.slice(0, 8).toUpperCase(), amount: r.i.amount, dueDate: r.i.dueDate, tenorDays: dayOf(r.i.dueDate) - dayOf(now),
    buyer: r.buyer, grade: r.uw.riskGrade, maxAdvanceBps: r.uw.advanceRateBps, guideDiscountBps: r.uw.discountRateBps, myBid: mine.get(r.i.id) ?? null,
  }));
}

/** Place (or replace) a bid. The advance is capped by the grade's advance rate and by the financier's available funds. */
export async function placeBid(db: Database, actor: FinancierActor, p: { invoiceId: string; advanceBps: number; discountBps: number }, gw: Adapters = gateway, now = new Date()) {
  if (actor.role !== "financier" || !actor.businessId) throw new Error("FORBIDDEN");
  const fid = actor.businessId;
  if (!Number.isInteger(p.discountBps) || p.discountBps < MARKET.minDiscountBps || p.discountBps > MARKET.maxDiscountBps)
    throw new Error(`the discount must be between ${MARKET.minDiscountBps / 100}% and ${MARKET.maxDiscountBps / 100}% a year`);
  const out = await db.transaction(async (tx) => {
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
    const price = priceOffer({ amount: inv.amount, advanceBps: p.advanceBps, discountBps: p.discountBps, tenorDays });
    const [seller] = await tx.select({ country: businesses.country, industry: businesses.industry }).from(businesses).where(eq(businesses.id, inv.sellerId));
    await assertActiveFinancier(tx, fid, seller?.country ?? "IN", now); // licensed where the seller is
    await assertWithinMandate(tx, fid, { buyerId: inv.buyerId, sellerId: inv.sellerId, grade: uw.riskGrade, advance: price.advanceAmount, tenorDays, industry: seller?.industry ?? null });
    if ((await position(tx, fid)).available < price.advanceAmount) throw new Error("you do not have enough available funds for this bid");
    await tx.update(bids).set({ status: "withdrawn", decidedAt: now }).where(and(eq(bids.invoiceId, inv.id), eq(bids.financierId, fid), eq(bids.status, "open")));
    const [bid] = await tx.insert(bids).values({
      invoiceId: inv.id, financierId: fid, advanceAmount: price.advanceAmount, discountBps: p.discountBps, feeAmount: price.feeAmount,
      expectedDiscount: price.expectedDiscount, tenorDays, expiresAt: new Date(Math.min(now.getTime() + MARKET.bidValidityHours * 3_600_000, new Date(inv.dueDate).getTime())),
    }).returning();
    await tx.insert(auditLog).values({ actorId: actor.id, action: "bid.place", entity: "invoice", entityId: inv.id, after: { bidId: bid.id, advance: price.advanceAmount.toString(), discountBps: p.discountBps } });
    return { bid, inv };
  });
  await notifyBusiness(db, out.inv.sellerId, "bid_received", { invoiceNumber: out.inv.invoiceNumber, advance: formatINR(out.bid.advanceAmount) }, gw);
  return out.bid;
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
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7001)`);
    const [bid] = await tx.select().from(bids).where(eq(bids.id, bidId)).for("update");
    if (!bid) throw new Error("bid not found");
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, bid.invoiceId));
    if (actor.role !== "seller" || actor.businessId !== inv.sellerId) throw new Error("FORBIDDEN");
    if (bid.status !== "open") throw new Error(`bid is ${bid.status}`);
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
    await assertActiveFinancier(tx, bid.financierId, seller?.country ?? "IN", now).catch(() => { throw new Error("that financier can no longer fund this invoice; choose another"); });
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
  });
  if (!out) throw new Error("bid has expired");
  await notifyBusiness(db, out.bid.financierId, "bid_accepted", { invoiceNumber: out.inv.invoiceNumber, advance: formatINR(out.bid.advanceAmount) }, gw);
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
    .where(and(eq(financingOffers.financierId, financierId), eq(financingOffers.status, "accepted"))).orderBy(desc(financingOffers.acceptedAt));
  return rows.map((r) => ({
    invoiceId: r.i.id, invoiceNumber: r.i.invoiceNumber, buyer: r.buyer, status: r.i.status, dueDate: r.i.dueDate,
    advance: r.o.advanceAmount, discountBps: r.o.discountBps, expectedDiscount: r.o.expectedDiscount,
    outstandingPrincipal: r.c?.principal ?? 0n, accruedDiscount: r.c?.discount ?? 0n, penal: r.c?.penal ?? 0n,
    dpd: Math.max(0, dayOf(now) - dayOf(r.i.dueDate)),
  }));
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
  const r = await db.execute(sql`
    select coalesce(sum((r.allocation->>'principal')::bigint), 0)::text as v
    from repayments r join financing_offers o on o.invoice_id = r.invoice_id and o.status = 'accepted' where o.financier_id = ${financierId}`);
  const v = (r as unknown as { rows: { v: string }[] }).rows[0].v;
  return { returned, earned: returned - BigInt(v) };
}
