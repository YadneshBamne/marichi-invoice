// Dynamic discounting. A buyer with spare cash proposes to pay an approved invoice early; the discount slides with how early.
// If the seller accepts, the buyer pays the reduced amount into the invoice's collection account, the platform keeps a fee,
// and the rest goes to the seller through the normal payout rail. No financier, no collections clock.
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, bids, businesses, earlyPayments, financingOffers, invoices, repayments, sellerPayouts, virtualAccounts } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { assertNotFrozen } from "../fraud/service";
import { ensureVirtualAccount } from "../collections/virtual-accounts";
import { ACCOUNTS, ensureAccounts } from "../ledger/accounts";
import { postEntry, type Line } from "../ledger/post";
import { splitTax } from "../ledger/tax";
import { notifyBusiness } from "../notify";
import { formatMoney } from "../../lib/money";
import { market } from "../../lib/countries";

import { DD, quoteEarly } from "./quote";
export { DD, quoteEarly };

const dayOf = (d: Date | string) => Math.floor(new Date(d).getTime() / 86_400_000);
export type Actor = { id: string; role: string; businessId: string | null };

/** An accepted early payment owns the invoice: no offer, bid or disbursement may compete with it. */
export async function assertNoEarlyPayment(db: Database | Tx, invoiceId: string) {
  const [e] = await db.select({ id: earlyPayments.id }).from(earlyPayments).where(and(eq(earlyPayments.invoiceId, invoiceId), eq(earlyPayments.status, "accepted")));
  if (e) throw new Error("the buyer has an accepted early payment on this invoice");
}

export async function proposeEarlyPayment(db: Database, actor: Actor, p: { invoiceId: string; discountBps: number }, gw: Adapters = gateway, now = new Date()) {
  if (actor.role !== "buyer" || !actor.businessId) throw new Error("FORBIDDEN");
  if (!Number.isInteger(p.discountBps) || p.discountBps < DD.minBps || p.discountBps > DD.maxBps)
    throw new Error(`the discount must be between ${DD.minBps / 100}% and ${DD.maxBps / 100}% a year`);
  const out = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");
    if (!inv || inv.buyerId !== actor.businessId) throw new Error("FORBIDDEN");
    if (inv.status !== "eligible" || inv.disputeFlag) throw new Error("only a confirmed invoice that has not been financed can be paid early");
    await assertNotFrozen(tx, inv.id);
    const [funded] = await tx.select({ id: financingOffers.id }).from(financingOffers).where(and(eq(financingOffers.invoiceId, inv.id), eq(financingOffers.status, "accepted")));
    if (funded) throw new Error("this invoice has already been financed");
    await assertNoEarlyPayment(tx, inv.id);
    const daysEarly = dayOf(inv.dueDate) - dayOf(now);
    if (daysEarly < DD.minDaysEarly) throw new Error(`early payment needs at least ${DD.minDaysEarly} days before the due date`);
    const q = quoteEarly(inv.amount, daysEarly, p.discountBps);
    await tx.update(earlyPayments).set({ status: "cancelled" }).where(and(eq(earlyPayments.invoiceId, inv.id), eq(earlyPayments.status, "proposed")));
    const [row] = await tx.insert(earlyPayments).values({
      invoiceId: inv.id, buyerId: inv.buyerId, sellerId: inv.sellerId, discountBps: p.discountBps, daysEarly,
      discountAmount: q.discount, netAmount: q.net, feeAmount: q.fee, expiresAt: new Date(now.getTime() + DD.proposalHours * 3_600_000), proposedBy: actor.id,
    }).returning();
    await tx.insert(auditLog).values({ actorId: actor.id, action: "early_payment.propose", entity: "invoice", entityId: inv.id, after: { id: row.id, discountBps: p.discountBps, net: q.net.toString() } });
    return { row, inv };
  });
  const [buyer] = await db.select({ n: businesses.legalName }).from(businesses).where(eq(businesses.id, out.inv.buyerId));
  await notifyBusiness(db, out.inv.sellerId, "early_payment_proposed", { invoiceNumber: out.inv.invoiceNumber, buyer: buyer.n, net: formatMoney(out.row.netAmount), discount: formatMoney(out.row.discountAmount) }, gw);
  return out.row;
}

export async function withdrawEarlyPayment(db: Database, actor: Actor, id: string) {
  const [r] = await db.update(earlyPayments).set({ status: "cancelled" })
    .where(and(eq(earlyPayments.id, id), eq(earlyPayments.buyerId, actor.businessId ?? ""), eq(earlyPayments.status, "proposed"))).returning();
  if (!r) throw new Error("only a proposal the seller has not answered can be withdrawn");
}

/** The seller answers. Accepting closes every competing route to money for this invoice and gives the buyer the account to pay. */
export async function respondEarlyPayment(db: Database, actor: Actor, id: string, to: "accept" | "decline", gw: Adapters = gateway, now = new Date()) {
  const out = await db.transaction(async (tx) => {
    const [ep] = await tx.select().from(earlyPayments).where(eq(earlyPayments.id, id)).for("update");
    if (!ep) throw new Error("proposal not found");
    if (actor.role !== "seller" || actor.businessId !== ep.sellerId) throw new Error("FORBIDDEN");
    if (ep.status !== "proposed") throw new Error(`proposal is ${ep.status}`);
    if (ep.expiresAt <= now) {
      await tx.update(earlyPayments).set({ status: "expired" }).where(eq(earlyPayments.id, ep.id));
      return null;
    }
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, ep.invoiceId));
    if (to === "accept") {
      if (inv.status !== "eligible" || inv.disputeFlag) throw new Error("this invoice can no longer be paid early");
      await assertNotFrozen(tx, inv.id);
      const [funded] = await tx.select({ id: financingOffers.id }).from(financingOffers).where(and(eq(financingOffers.invoiceId, inv.id), eq(financingOffers.status, "accepted")));
      if (funded) throw new Error("this invoice has already been financed");
      await tx.update(financingOffers).set({ status: "rejected" }).where(and(eq(financingOffers.invoiceId, inv.id), eq(financingOffers.status, "open")));
      await tx.update(bids).set({ status: "rejected", decidedAt: now }).where(and(eq(bids.invoiceId, inv.id), eq(bids.status, "open")));
    }
    const payBy = new Date(Math.min(now.getTime() + DD.payWithinDays * 86_400_000, new Date(inv.dueDate).getTime()));
    const [row] = await tx.update(earlyPayments).set({
      status: to === "accept" ? "accepted" : "declined", respondedBy: actor.id, respondedAt: now, ...(to === "accept" ? { expiresAt: payBy } : {}),
    }).where(eq(earlyPayments.id, ep.id)).returning();
    await tx.insert(auditLog).values({ actorId: actor.id, action: `early_payment.${to}`, entity: "invoice", entityId: inv.id, after: { id: ep.id } });
    return { row, inv };
  });
  if (!out) throw new Error("proposal has expired");
  if (to === "decline") {
    await notifyBusiness(db, out.row.buyerId, "early_payment_declined", { invoiceNumber: out.inv.invoiceNumber }, gw);
    return out.row;
  }
  const va = await ensureVirtualAccount(db, out.inv.id, gw);
  await notifyBusiness(db, out.row.buyerId, "early_payment_accepted", {
    invoiceNumber: out.inv.invoiceNumber, net: formatMoney(out.row.netAmount), account: va.accountNumber, ifsc: `${market().ids.bankCode.label} ${va.ifsc}`, by: out.row.expiresAt.toLocaleDateString("en-IN"),
  }, gw);
  return out.row;
}

/**
 * Called from the collections path when a bank credit lands on an invoice that has an accepted early payment.
 * The amount must be exactly the agreed net; anything else is left for ops to sort out rather than guessed at.
 */
export async function settleEarlyPayment(tx: Tx, ep: typeof earlyPayments.$inferSelect, inv: typeof invoices.$inferSelect, c: { amount: bigint; utr: string; receivedAt: Date }, now: Date) {
  if (c.amount !== ep.netAmount) return { status: "unmatched" as const, reason: `early payment must be exactly ${formatMoney(ep.netAmount)}` };
  const [rep] = await tx.insert(repayments).values({
    invoiceId: inv.id, amount: c.amount, utr: c.utr, receivedAt: c.receivedAt,
    allocation: { earlyPayment: true, discount: ep.discountAmount.toString(), fee: ep.feeAmount.toString() },
  }).returning();
  const fee = splitTax(ep.feeAmount);
  const toSeller = c.amount - ep.feeAmount;
  await ensureAccounts(tx, [ACCOUNTS.escrow, ACCOUNTS.sellerPayable(inv.sellerId), ACCOUNTS.feeIncome, ACCOUNTS.gstPayable]);
  const lines: Line[] = [
    { account: ACCOUNTS.escrow, direction: "debit", amount: c.amount },
    { account: ACCOUNTS.sellerPayable(inv.sellerId), direction: "credit", amount: toSeller },
  ];
  if (fee.base > 0n) lines.push({ account: ACCOUNTS.feeIncome, direction: "credit", amount: fee.base });
  if (fee.tax > 0n) lines.push({ account: ACCOUNTS.gstPayable, direction: "credit", amount: fee.tax });
  await postEntry(tx, { ref: `early:${c.utr}`, type: "early_payment", lines });
  await tx.insert(sellerPayouts).values({ repaymentId: rep.id, sellerId: inv.sellerId, amount: toSeller, idempotencyKey: `surplus:${rep.id}` });
  await tx.update(earlyPayments).set({ status: "paid", paidAt: now }).where(eq(earlyPayments.id, ep.id));
  await tx.update(invoices).set({ status: "paid" }).where(eq(invoices.id, inv.id));
  await tx.insert(auditLog).values({ action: "early_payment.paid", entity: "invoice", entityId: inv.id, after: { utr: c.utr, amount: c.amount.toString(), toSeller: toSeller.toString() } });
  return { status: "applied" as const, invoiceId: inv.id, closed: true, surplus: toSeller };
}

/** Worker: lapse proposals the seller ignored and accepted ones the buyer never paid, so normal financing can resume. */
export async function expireEarlyPayments(db: Database, now = new Date()) {
  const r = await db.update(earlyPayments).set({ status: "expired" })
    .where(and(inArray(earlyPayments.status, ["proposed", "accepted"]), lte(earlyPayments.expiresAt, now))).returning({ id: earlyPayments.id });
  return r.length;
}

/** Proposals the seller still has to answer, and the buyer's own, newest first. */
export async function listEarlyPayments(db: Database, by: { sellerId?: string; buyerId?: string }) {
  const where = by.sellerId ? eq(earlyPayments.sellerId, by.sellerId) : eq(earlyPayments.buyerId, by.buyerId!);
  return db.select({ e: earlyPayments, inv: invoices, buyer: businesses.legalName, va: virtualAccounts.accountNumber, ifsc: virtualAccounts.ifsc }).from(earlyPayments)
    .innerJoin(invoices, eq(invoices.id, earlyPayments.invoiceId))
    .innerJoin(businesses, eq(businesses.id, earlyPayments.buyerId))
    .leftJoin(virtualAccounts, eq(virtualAccounts.invoiceId, earlyPayments.invoiceId))
    .where(where).orderBy(sql`${earlyPayments.createdAt} desc`).limit(100);
}
