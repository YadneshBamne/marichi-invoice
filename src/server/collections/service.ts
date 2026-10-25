import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import {
  auditLog, businessBankAccounts, collectionEvents, earlyPayments, financingOffers, invoiceCollections, invoiceDisputes, invoices, repayments,
  sellerPayouts, tdsWithheld, unmatchedCredits, virtualAccounts,
} from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { railPlan } from "../disbursements/service";
import { ACCOUNTS, ensureAccounts } from "../ledger/accounts";
import { postEntry, type Line } from "../ledger/post";
import { notifyBusiness, notifyStaff } from "../notify";
import { emitEvent } from "../erp/events";
import { formatMoney } from "../../lib/money";
import { repaymentLegs } from "../marketplace/service";
import { participantsOf, splitAmount } from "../marketplace/pool";
import { settleEarlyPayment } from "../earlypay/service";
import { accrue, applyPayment, bucketOf, COLLECTIONS, daysBetween, isoDay, type State } from "./waterfall";

const asState = (c: typeof invoiceCollections.$inferSelect): State => ({ principal: c.principal, discount: c.discount, penal: c.penal, lastAccrued: c.lastAccruedOn });
const ratesOf = (c: typeof invoiceCollections.$inferSelect, dueDate: string) => ({ discountBps: c.discountBps, penalBps: c.penalBps, dueDate });
const STAFF = ["ops", "admin"];

/**
 * Accrue to `upTo` and book the new discount as income (Dr accrued_discount_receivable, Cr discount_income).
 * Returns the new state; the caller persists it. Idempotent per (invoice, date): the ledger ref de-dupes.
 */
async function accrueAndPost(tx: Tx, col: typeof invoiceCollections.$inferSelect, inv: typeof invoices.$inferSelect, upTo: string): Promise<State> {
  const s = accrue(asState(col), upTo, ratesOf(col, inv.dueDate));
  const delta = s.discount - col.discount;
  if (delta > 0n) {
    await ensureAccounts(tx, [ACCOUNTS.accruedDiscount, ACCOUNTS.discountIncome]);
    await postEntry(tx, { ref: `accr:${inv.id}:${upTo}`, type: "accrual", lines: [
      { account: ACCOUNTS.accruedDiscount, direction: "debit", amount: delta },
      { account: ACCOUNTS.discountIncome, direction: "credit", amount: delta },
    ] });
  }
  return s;
}

type Credit = { accountNumber: string; amount: bigint; utr: string; receivedAt: Date };
type Outcome = { status: "applied"; invoiceId: string; closed: boolean; surplus: bigint } | { status: "replayed" } | { status: "unmatched"; reason: string };

/** Apply one bank credit to one invoice: waterfall, ledger, state, invoice status, surplus payout row. One transaction. */
async function settle(db: Database, invoiceId: string, c: Credit, now: Date, gw: Adapters, resolveUnmatchedId?: string): Promise<Outcome> {
  const out = await db.transaction(async (tx): Promise<Outcome & { sellerId?: string; invoiceNumber?: string; buyerId?: string }> => {
    const [dupe] = await tx.select({ id: repayments.id }).from(repayments).where(eq(repayments.utr, c.utr));
    if (dupe) return { status: "replayed" };
    const [col] = await tx.select().from(invoiceCollections).where(eq(invoiceCollections.invoiceId, invoiceId)).for("update");
    if (!col) {
      // Not financed: it may be a buyer paying early (dynamic discounting).
      const [ep] = await tx.select().from(earlyPayments).where(and(eq(earlyPayments.invoiceId, invoiceId), eq(earlyPayments.status, "accepted"))).for("update");
      if (!ep) return { status: "unmatched", reason: "invoice not financed yet" };
      const [einv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
      const r = await settleEarlyPayment(tx, ep, einv, c, now);
      return r.status === "applied" ? { ...r, sellerId: einv.sellerId, buyerId: einv.buyerId, invoiceNumber: einv.invoiceNumber } : r;
    }
    if (col.closedAt) return { status: "unmatched", reason: "invoice already settled" };
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));

    const upTo = isoDay(c.receivedAt) > col.lastAccruedOn ? isoDay(c.receivedAt) : col.lastAccruedOn;
    const { state, paid, surplus } = applyPayment(await accrueAndPost(tx, col, inv, upTo), c.amount);
    const closed = state.principal === 0n && state.discount === 0n && state.penal === 0n;

    const [rep] = await tx.insert(repayments).values({
      invoiceId, amount: c.amount, utr: c.utr, receivedAt: c.receivedAt,
      allocation: { principal: paid.principal.toString(), discount: paid.discount.toString(), penal: paid.penal.toString(), surplus: surplus.toString() },
    }).returning();

    await ensureAccounts(tx, [ACCOUNTS.escrow, ACCOUNTS.receivable(inv.sellerId), ACCOUNTS.accruedDiscount, ACCOUNTS.penalIncome, ACCOUNTS.sellerPayable(inv.sellerId)]);
    // Discount was already booked as income as it accrued, so collecting it just clears the accrued receivable.
    // Penal charges are recognised only when actually received (conservative).
    const credits: [string, bigint][] = [
      [ACCOUNTS.receivable(inv.sellerId), paid.principal], [ACCOUNTS.accruedDiscount, paid.discount],
      [ACCOUNTS.penalIncome, paid.penal], [ACCOUNTS.sellerPayable(inv.sellerId), surplus],
    ];
    const lines: Line[] = [{ account: ACCOUNTS.escrow, direction: "debit", amount: c.amount }];
    for (const [account, amount] of credits) if (amount > 0n) lines.push({ account, direction: "credit", amount });
    const [offer] = await tx.select().from(financingOffers).where(and(eq(financingOffers.invoiceId, invoiceId), eq(financingOffers.status, "accepted")));
    const parts = offer ? await participantsOf(tx, offer) : [];
    let held: { financierId: string; base: bigint; rateBps: number; amount: bigint }[] = [];
    if (parts.length) { // financier-funded: each one's principal and share of discount/penal go back to its funds, less any tax held back
      await ensureAccounts(tx, [...parts.flatMap((x) => [ACCOUNTS.financierFunds(x.financierId), ACCOUNTS.financierDeployed(x.financierId)]), ACCOUNTS.discountIncome, ACCOUNTS.tdsPayable]);
      const legs = repaymentLegs(parts, paid);
      lines.push(...legs.lines);
      held = legs.tds;
    }
    await postEntry(tx, { ref: `repay:${c.utr}`, type: "repayment", lines });
    for (const t of held) await tx.insert(tdsWithheld).values({ financierId: t.financierId, invoiceId, repaymentId: rep.id, base: t.base, rateBps: t.rateBps, amount: t.amount });

    await tx.update(invoiceCollections).set({
      principal: state.principal, discount: state.discount, penal: state.penal, lastAccruedOn: state.lastAccrued, closedAt: closed ? now : null,
    }).where(eq(invoiceCollections.invoiceId, invoiceId));
    if (closed) await tx.update(invoices).set({ status: "paid" }).where(eq(invoices.id, invoiceId));
    if (surplus > 0n) {
      await tx.insert(sellerPayouts).values({ repaymentId: rep.id, sellerId: inv.sellerId, amount: surplus, idempotencyKey: `surplus:${rep.id}` });
    }
    if (resolveUnmatchedId) await tx.update(unmatchedCredits).set({ resolvedAt: now }).where(eq(unmatchedCredits.id, resolveUnmatchedId));
    await tx.insert(auditLog).values({
      action: "repayment.apply", entity: "invoice", entityId: invoiceId,
      after: { utr: c.utr, amount: c.amount.toString(), paid: { principal: paid.principal.toString(), discount: paid.discount.toString(), penal: paid.penal.toString() }, surplus: surplus.toString(), closed },
    });
    return { status: "applied", invoiceId, closed, surplus, sellerId: inv.sellerId, buyerId: inv.buyerId, invoiceNumber: inv.invoiceNumber };
  });

  if (out.status === "applied") {
    const d = { invoiceNumber: out.invoiceNumber!, amount: formatMoney(c.amount) };
    await notifyBusiness(db, out.buyerId!, "payment_received", d, gw);
    await notifyBusiness(db, out.sellerId!, out.closed ? "invoice_settled" : "payment_received_partial", d, gw);
    const ev = { invoiceNumber: out.invoiceNumber, amountPaise: c.amount.toString(), utr: c.utr, receivedAt: c.receivedAt.toISOString(), settled: out.closed, surplusToSellerPaise: out.surplus.toString() };
    await emitEvent(db, out.sellerId!, out.closed ? "invoice.paid" : "invoice.payment_received", ev, now);
    await emitEvent(db, out.buyerId!, "invoice.payment_received", { invoiceNumber: out.invoiceNumber, amountPaise: c.amount.toString(), utr: c.utr, settled: out.closed }, now);
  }
  return out;
}

/**
 * Bank credit notification for a virtual account (webhook or statement feed). Idempotent on the UTR.
 * Anything that can't be applied goes to the unmatched queue for ops instead of being dropped.
 */
export async function recordIncomingPayment(db: Database, c: Credit, gw: Adapters = gateway, now = new Date()) {
  if (c.amount <= 0n) throw new Error("amount must be positive");
  const [seen] = await db.select({ id: unmatchedCredits.id }).from(unmatchedCredits).where(eq(unmatchedCredits.utr, c.utr));
  if (seen) return { status: "replayed" } as Outcome;
  const [va] = await db.select().from(virtualAccounts).where(eq(virtualAccounts.accountNumber, c.accountNumber));
  const result: Outcome = va ? await settle(db, va.invoiceId, c, now, gw) : { status: "unmatched", reason: "unknown account" };
  if (result.status === "unmatched") {
    await db.insert(unmatchedCredits).values({ utr: c.utr, accountNumber: c.accountNumber, amount: c.amount, receivedAt: c.receivedAt, reason: result.reason }).onConflictDoNothing();
    await notifyStaff(db, ["ops"], "unmatched_credit", { utr: c.utr, reason: result.reason }, gw);
  }
  return result;
}

/** Ops assign an unmatched credit to the right invoice by hand. */
export async function matchUnmatched(db: Database, creditId: string, invoiceId: string, staff: { id: string; role: string }, gw: Adapters = gateway, now = new Date()) {
  if (!STAFF.includes(staff.role)) throw new Error("forbidden");
  const [u] = await db.select().from(unmatchedCredits).where(eq(unmatchedCredits.id, creditId));
  if (!u || u.resolvedAt) throw new Error("credit not found or already resolved");
  const r = await settle(db, invoiceId, { accountNumber: u.accountNumber, amount: u.amount, utr: u.utr, receivedAt: u.receivedAt }, now, gw, u.id);
  if (r.status !== "applied") throw new Error(r.status === "unmatched" ? r.reason : "already applied");
  await db.insert(auditLog).values({ actorId: staff.id, action: "repayment.manual_match", entity: "invoice", entityId: invoiceId, after: { creditId } });
  return r;
}

async function once(db: Database, invoiceId: string, kind: string) {
  const r = await db.insert(collectionEvents).values({ invoiceId, kind }).onConflictDoNothing().returning({ id: collectionEvents.id });
  return r.length > 0;
}

/**
 * Daily worker (PRD Module 9): accrue discount + penal, move invoices financed -> due -> overdue, send the reminder ladder,
 * trigger the recourse notice after the grace period, and flag NPAs. Re-running the same day sends nothing twice.
 */
export async function runCollectionsSweep(db: Database, gw: Adapters = gateway, now = new Date()) {
  const today = isoDay(now);
  const rows = await db.select({ c: invoiceCollections, i: invoices }).from(invoiceCollections)
    .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).where(isNull(invoiceCollections.closedAt));
  const n = { accrued: 0, events: 0 };
  const disputed = new Set((await db.select({ id: invoiceDisputes.invoiceId }).from(invoiceDisputes).where(eq(invoiceDisputes.status, "open"))).map((r) => r.id));
  for (const { c, i } of rows) {
    const accrued = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(invoiceCollections).where(eq(invoiceCollections.invoiceId, i.id)).for("update");
      if (cur.closedAt) return false; // paid while we were iterating
      const s = await accrueAndPost(tx, cur, i, today);
      if (s.lastAccrued === cur.lastAccruedOn) return false;
      await tx.update(invoiceCollections).set({ discount: s.discount, penal: s.penal, lastAccruedOn: s.lastAccrued }).where(eq(invoiceCollections.invoiceId, i.id));
      return true;
    });
    if (accrued) n.accrued++;
    if (disputed.has(i.id)) continue; // open dispute: no reminders, no overdue/recourse transitions (PRD Module 16). Accrual above still ran.
    const dpd = daysBetween(i.dueDate, today);
    const toDue = -dpd;
    const info = { invoiceNumber: i.invoiceNumber, due: i.dueDate, amount: formatMoney(i.amount) };
    const send = async (kind: string, fn: () => Promise<unknown>) => { if (await once(db, i.id, kind)) { await fn(); n.events++; } };

    if (dpd > COLLECTIONS.graceDays && ["financed", "due"].includes(i.status)) {
      await db.update(invoices).set({ status: "overdue" }).where(eq(invoices.id, i.id));
      const ev = { invoiceNumber: i.invoiceNumber, dueDate: i.dueDate, daysPastDue: dpd };
      await emitEvent(db, i.sellerId, "invoice.overdue", ev, now);
      await emitEvent(db, i.buyerId, "invoice.overdue", ev, now);
    }
    else if (dpd >= 0 && i.status === "financed") await db.update(invoices).set({ status: "due" }).where(eq(invoices.id, i.id));

    if (toDue > 0 && toDue <= 3) await send("pre_due", () => notifyBusiness(db, i.buyerId, "payment_reminder_pre_due", info, gw));
    if (dpd === 0) await send("due_today", () => notifyBusiness(db, i.buyerId, "payment_due_today", info, gw));
    if (dpd >= 1) await send("overdue_1", () => notifyBusiness(db, i.buyerId, "payment_overdue", info, gw));
    if (dpd > COLLECTIONS.graceDays) {
      // With-recourse: the seller becomes liable once the grace period lapses. (NACH auto-debit comes with a real mandate provider.)
      await send("recourse_notice", () => notifyBusiness(db, i.sellerId, "recourse_notice", { ...info, dpd: String(dpd) }, gw));
    }
    if (dpd >= 30) await send("overdue_30", () => notifyStaff(db, ["ops", "admin"], "collections_escalation", { ...info, dpd: String(dpd) }, gw));
    if (dpd > COLLECTIONS.writeOffAfterDpd) await send("npa", () => notifyStaff(db, ["admin"], "write_off_review", { ...info, dpd: String(dpd) }, gw));
  }
  return n;
}

/** Admin write-off of an NPA (> 90 DPD). Books the unrecovered principal as credit loss. Uncollected discount/penal was never income. */
export async function writeOff(db: Database, invoiceId: string, staff: { id: string; role: string }, note: string, now = new Date()) {
  if (staff.role !== "admin") throw new Error("forbidden");
  if (!note.trim()) throw new Error("a note is required");
  return db.transaction(async (tx) => {
    const [col] = await tx.select().from(invoiceCollections).where(eq(invoiceCollections.invoiceId, invoiceId)).for("update");
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!col || col.closedAt) throw new Error("nothing outstanding on this invoice");
    if (daysBetween(inv.dueDate, isoDay(now)) <= COLLECTIONS.writeOffAfterDpd) throw new Error(`not yet ${COLLECTIONS.writeOffAfterDpd}+ days past due`);
    await ensureAccounts(tx, [ACCOUNTS.creditLoss, ACCOUNTS.receivable(inv.sellerId), ACCOUNTS.accruedDiscount, ACCOUNTS.discountIncome]);
    // Principal is lost; discount we already booked as income but will never collect is reversed out of income.
    const [offer] = await tx.select().from(financingOffers).where(and(eq(financingOffers.invoiceId, invoiceId), eq(financingOffers.status, "accepted")));
    const parts = offer ? await participantsOf(tx, offer) : [];
    if (parts.length) await ensureAccounts(tx, parts.map((x) => ACCOUNTS.financierDeployed(x.financierId)));
    const loss = parts.length ? splitAmount(col.principal, parts.map((x) => x.shareBps)) : [];
    const lines: Line[] = [
      // each financier bears its own share of the loss; with none, the platform does
      ...(parts.length
        ? parts.flatMap((x, i) => (loss[i] > 0n ? [{ account: ACCOUNTS.financierDeployed(x.financierId), direction: "debit" as const, amount: loss[i] }] : []))
        : [{ account: ACCOUNTS.creditLoss, direction: "debit" as const, amount: col.principal }]),
      { account: ACCOUNTS.receivable(inv.sellerId), direction: "credit", amount: col.principal },
    ];
    if (col.discount > 0n) {
      lines.push({ account: ACCOUNTS.discountIncome, direction: "debit", amount: col.discount }, { account: ACCOUNTS.accruedDiscount, direction: "credit", amount: col.discount });
    }
    await postEntry(tx, { ref: `writeoff:${invoiceId}`, type: "write_off", lines });
    await tx.update(invoiceCollections).set({ principal: 0n, discount: 0n, penal: 0n, closedAt: now }).where(eq(invoiceCollections.invoiceId, invoiceId));
    await tx.update(invoices).set({ status: "written_off" }).where(eq(invoices.id, invoiceId));
    await tx.insert(auditLog).values({ actorId: staff.id, action: "invoice.write_off", entity: "invoice", entityId: invoiceId, after: { principal: col.principal.toString(), note } });
    return { principal: col.principal };
  });
}

/** Worker: pay seller surpluses out of escrow (same rail plan and idempotency rules as disbursements). */
export async function runSurplusPayouts(db: Database, gw: Adapters = gateway) {
  const due = await db.select().from(sellerPayouts).where(inArray(sellerPayouts.status, ["pending", "failed", "processing"]));
  let paid = 0;
  for (const p of due) {
    if (p.status === "failed" && p.attempts >= 2) continue; // ops queue
    const [acct] = await db.select().from(businessBankAccounts)
      .where(and(eq(businessBankAccounts.businessId, p.sellerId), eq(businessBankAccounts.verified, true))).limit(1);
    if (!acct) continue;
    const rail = railPlan(p.amount)[Math.min(p.attempts, 1)];
    await db.update(sellerPayouts).set({ status: "processing" }).where(eq(sellerPayouts.id, p.id));
    const res = await gw.payments.payout({ idempotencyKey: `${p.idempotencyKey}:${p.attempts}`, amount: p.amount, ifsc: acct.ifsc, account: acct.accountNumber, rail });
    const status = res.status === "processing" && p.bankRef ? await gw.payments.payoutStatus(p.bankRef) : res.status;
    if (status === "succeeded") {
      await db.transaction(async (tx) => {
        await postEntry(tx, { ref: `surplus:${p.id}`, type: "surplus_payout", lines: [
          { account: ACCOUNTS.sellerPayable(p.sellerId), direction: "debit", amount: p.amount },
          { account: ACCOUNTS.escrow, direction: "credit", amount: p.amount },
        ] });
        await tx.update(sellerPayouts).set({ status: "succeeded", bankRef: res.bankRef, completedAt: new Date() }).where(eq(sellerPayouts.id, p.id));
      });
      await notifyBusiness(db, p.sellerId, "surplus_paid", { amount: formatMoney(p.amount) }, gw);
      paid++;
    } else if (status === "failed") {
      await db.update(sellerPayouts).set({ status: "failed", attempts: p.attempts + 1, failureReason: res.reason ?? `${rail} failed` }).where(eq(sellerPayouts.id, p.id));
    } else {
      await db.update(sellerPayouts).set({ bankRef: res.bankRef }).where(eq(sellerPayouts.id, p.id));
    }
  }
  return paid;
}

/** Portfolio view for ops: every open invoice with DPD and bucket. */
export async function delinquencyReport(db: Database, now = new Date()) {
  const rows = await db.select({ c: invoiceCollections, i: invoices }).from(invoiceCollections)
    .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).where(isNull(invoiceCollections.closedAt));
  return rows.map(({ c, i }) => {
    const dpd = Math.max(0, daysBetween(i.dueDate, isoDay(now)));
    const s = accrue(asState(c), isoDay(now), ratesOf(c, i.dueDate));
    return { invoiceId: i.id, invoiceNumber: i.invoiceNumber, dueDate: i.dueDate, dpd, bucket: bucketOf(dpd), principal: s.principal, discount: s.discount, penal: s.penal };
  }).sort((a, b) => b.dpd - a.dpd);
}
