import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businessBankAccounts, businesses, disbursements, financingOffers, invoiceCollections, invoices } from "../db/schema";
import { COLLECTIONS, isoDay } from "../collections/waterfall";
import { gateway, type Adapters, type Rail } from "../integrations/gateway";
import { assertNotFrozen } from "../fraud/service";
import { assertReadyToDisburse } from "../agreements/service";
import { ACCOUNTS, balance, ensureAccounts } from "../ledger/accounts";
import { postEntry } from "../ledger/post";
import { splitGst } from "../ledger/tax";
import { assertPreviousDayReconciled } from "../recon/service";
import { notifyBusiness, notifyStaff } from "../notify";
import { emitEvent } from "../erp/events";
import { platformCash, position } from "../marketplace/service";
import { assertActiveFinancier } from "../marketplace/financier";
import { formatINR } from "../../lib/money";

export const DISBURSE = {
  approvalThreshold: 10_00_000_00n, // > ₹10L needs a second person (maker-checker)
  autoAttempts: 2, // automatic tries (primary + alternate rail) before it lands in the ops queue
};

/** Rail plan by amount: small => IMPS then NEFT; larger => RTGS then NEFT. */
export const railPlan = (amount: bigint): Rail[] => (amount <= 5_00_000_00n ? ["IMPS", "NEFT"] : ["RTGS", "NEFT"]);

const STAFF = ["ops", "admin"];

/** Put own-balance-sheet money into escrow. Funds must be in escrow before any payout (PRD Module 8). */
export async function fundEscrow(db: Database, p: { amount: bigint; ref: string; staffId: string; staffRole: string }) {
  if (!STAFF.includes(p.staffRole)) throw new Error("forbidden");
  if (p.amount <= 0n) throw new Error("amount must be positive");
  return db.transaction(async (tx) => {
    await ensureAccounts(tx, [ACCOUNTS.escrow, ACCOUNTS.capital]);
    const r = await postEntry(tx, { ref: `fund:${p.ref}`, type: "capital_in", lines: [
      { account: ACCOUNTS.escrow, direction: "debit", amount: p.amount },
      { account: ACCOUNTS.capital, direction: "credit", amount: p.amount },
    ] });
    if (!r.replayed) await tx.insert(auditLog).values({ actorId: p.staffId, action: "escrow.fund", entity: "ledger", entityId: r.id, after: { amount: p.amount.toString() } });
    return r;
  });
}

/**
 * Queue the payout for an accepted offer whose agreements are fully executed. One disbursement per offer (unique).
 * Amount = advance - upfront fee. Amounts over the threshold need a checker before they can be sent.
 */
export async function requestDisbursement(db: Database, offerId: string, makerId?: string) {
  const [offer] = await db.select().from(financingOffers).where(eq(financingOffers.id, offerId));
  if (!offer || offer.status !== "accepted") throw new Error("offer not accepted");
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, offer.invoiceId));
  if (inv.status !== "eligible" || inv.disputeFlag) throw new Error(`invoice cannot be funded (${inv.status})`);
  await assertNotFrozen(db, inv.id);
  const [seller] = await db.select().from(businesses).where(eq(businesses.id, inv.sellerId));
  if (seller.kybStatus !== "approved") throw new Error("seller KYB not approved");
  await assertReadyToDisburse(db, offerId); // signed agreements + assignment notice; no bypass
  const [acct] = await db.select().from(businessBankAccounts)
    .where(and(eq(businessBankAccounts.businessId, seller.id), eq(businessBankAccounts.verified, true))).orderBy(desc(businessBankAccounts.createdAt)).limit(1);
  if (!acct) throw new Error("no verified bank account");

  const amount = offer.advanceAmount - offer.feeAmount;
  const [row] = await db.insert(disbursements).values({
    offerId, amount, idempotencyKey: `disb:${offerId}`, makerId, needsApproval: amount > DISBURSE.approvalThreshold,
  }).onConflictDoNothing().returning();
  if (row) await db.insert(auditLog).values({ actorId: makerId, action: "disbursement.request", entity: "offer", entityId: offerId, after: { amount: amount.toString(), needsApproval: row.needsApproval } });
  return row ?? (await db.select().from(disbursements).where(eq(disbursements.offerId, offerId)))[0];
}

/** Checker step. Must be a different person than the maker. */
export async function approveDisbursement(db: Database, id: string, approver: { id: string; role: string }, now = new Date()) {
  if (!STAFF.includes(approver.role)) throw new Error("forbidden");
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(disbursements).where(eq(disbursements.id, id)).for("update");
    if (!d) throw new Error("disbursement not found");
    if (!d.needsApproval) throw new Error("approval not required");
    if (d.approvedAt) throw new Error("already approved");
    if (d.status !== "pending") throw new Error(`disbursement is ${d.status}`);
    if (d.makerId && d.makerId === approver.id) throw new Error("maker cannot approve their own disbursement");
    await tx.update(disbursements).set({ approvedBy: approver.id, approvedAt: now }).where(eq(disbursements.id, id));
    await tx.insert(auditLog).values({ actorId: approver.id, action: "disbursement.approve", entity: "disbursement", entityId: id });
  });
}

async function finalize(db: Database, d: typeof disbursements.$inferSelect, bankRef: string, now: Date, gw: Adapters) {
  const done = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(disbursements).where(eq(disbursements.id, d.id)).for("update");
    if (cur.status === "succeeded") return null; // replayed webhook / concurrent poll
    const [offer] = await tx.select().from(financingOffers).where(eq(financingOffers.id, d.offerId));
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, offer.invoiceId));
    await ensureAccounts(tx, [ACCOUNTS.escrow, ACCOUNTS.feeIncome, ACCOUNTS.gstPayable, ACCOUNTS.receivable(inv.sellerId)]);
    // Advance becomes a receivable from the seller; cash leaves escrow; the (GST-inclusive) fee is earned immediately.
    const fee = splitGst(offer.feeAmount);
    await postEntry(tx, { ref: `disb:${d.id}`, type: "disbursement", lines: [
      { account: ACCOUNTS.receivable(inv.sellerId), direction: "debit", amount: offer.advanceAmount },
      { account: ACCOUNTS.escrow, direction: "credit", amount: d.amount },
      ...(fee.base > 0n ? [{ account: ACCOUNTS.feeIncome, direction: "credit" as const, amount: fee.base }] : []),
      ...(fee.gst > 0n ? [{ account: ACCOUNTS.gstPayable, direction: "credit" as const, amount: fee.gst }] : []),
    ] });
    if (offer.financierId) { // the advance is now the financier's capital out in this invoice
      await ensureAccounts(tx, [ACCOUNTS.financierFunds(offer.financierId), ACCOUNTS.financierDeployed(offer.financierId)]);
      await postEntry(tx, { ref: `deploy:${d.id}`, type: "deploy", lines: [
        { account: ACCOUNTS.financierFunds(offer.financierId), direction: "debit", amount: offer.advanceAmount },
        { account: ACCOUNTS.financierDeployed(offer.financierId), direction: "credit", amount: offer.advanceAmount },
      ] });
    }
    await tx.update(disbursements).set({ status: "succeeded", bankRef, completedAt: now, failureReason: null }).where(eq(disbursements.id, d.id));
    // Start the collections clock: the seller now owes the advance, accruing discount from today (Module 9).
    await tx.insert(invoiceCollections).values({
      invoiceId: inv.id, principal: offer.advanceAmount, discountBps: offer.discountBps,
      penalBps: COLLECTIONS.penalBps, lastAccruedOn: isoDay(now),
    }).onConflictDoNothing();
    await tx.update(invoices).set({ status: "financed" }).where(eq(invoices.id, inv.id));
    await tx.insert(auditLog).values({ action: "disbursement.succeeded", entity: "disbursement", entityId: d.id, after: { bankRef } });
    return inv;
  });
  if (done) {
    await notifyBusiness(db, done.sellerId, "disbursed", { invoiceNumber: done.invoiceNumber, amount: formatINR(d.amount) }, gw);
    await emitEvent(db, done.sellerId, "invoice.financed", { invoiceNumber: done.invoiceNumber, netPayoutPaise: d.amount.toString(), bankRef, paidOutAt: now.toISOString() }, now);
  }
}

async function fail(db: Database, d: typeof disbursements.$inferSelect, reason: string, gw: Adapters) {
  const [row] = await db.update(disbursements).set({ status: "failed", attempts: sql`${disbursements.attempts} + 1`, failureReason: reason })
    .where(and(eq(disbursements.id, d.id), inArray(disbursements.status, ["processing", "pending"]))).returning();
  if (row && row.attempts >= DISBURSE.autoAttempts) {
    await notifyStaff(db, ["ops", "admin"], "disbursement_needs_attention", { disbursementId: d.id, reason }, gw);
  }
}

/**
 * Send the money. Safe to call repeatedly:
 *  - the payout key is `${id}:${attempts}`, so a retry after a timeout hits the provider's idempotency and cannot pay twice;
 *  - a new rail (new key) is used only after the previous attempt is a confirmed failure;
 *  - the ledger entry is keyed to the disbursement, so a replay can't post twice.
 */
export async function executeDisbursement(db: Database, id: string, gw: Adapters = gateway, now = new Date()) {
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7002)`); // serialise the escrow check + reservation
    const [d] = await tx.select().from(disbursements).where(eq(disbursements.id, id)).for("update");
    if (!d) throw new Error("disbursement not found");
    if (d.status === "succeeded") return { done: true as const };
    if (d.needsApproval && !d.approvedAt) throw new Error("APPROVAL_REQUIRED");
    if (d.status === "failed") throw new Error("disbursement failed; it must be re-queued (worker auto-retry or ops retry)");
    const [offer] = await tx.select().from(financingOffers).where(eq(financingOffers.id, d.offerId));
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, offer.invoiceId));
    if (d.status === "pending" && (inv.status !== "eligible" || inv.disputeFlag)) throw new Error(`invoice cannot be funded (${inv.status})`);
    if (d.status === "pending") await assertNotFrozen(tx, inv.id); // a case opened after signing still stops the money
    const [acct] = await tx.select().from(businessBankAccounts)
      .where(and(eq(businessBankAccounts.businessId, inv.sellerId), eq(businessBankAccounts.verified, true))).orderBy(desc(businessBankAccounts.createdAt)).limit(1);
    if (!acct) throw new Error("no verified bank account");
    const rails = railPlan(d.amount);
    const rail = rails[Math.min(d.attempts, rails.length - 1)];
    if (d.status === "pending") {
      // Reserve: escrow balance minus payouts already in flight must cover this one.
      const [{ inflight }] = await tx.select({ inflight: sql<string>`coalesce(sum(${disbursements.amount}), 0)` }).from(disbursements).where(eq(disbursements.status, "processing"));
      if ((await balance(tx, ACCOUNTS.escrow)) - BigInt(inflight) < d.amount) throw new Error("ESCROW_INSUFFICIENT");
      if (!offer.financierId && (await platformCash(tx)) - BigInt(inflight) < d.amount) throw new Error("ESCROW_INSUFFICIENT"); // financiers' cash is not ours to lend
      if (offer.financierId) {
        await assertActiveFinancier(tx, offer.financierId, null).catch((e) => { throw new Error(`FINANCIER_NOT_ACTIVE: ${(e as Error).message}`); }); // a lapsed or suspended licence stops the payout
        if ((await position(tx, offer.financierId)).funds < offer.advanceAmount) throw new Error("FINANCIER_FUNDS_INSUFFICIENT");
      }
      await tx.update(disbursements).set({ status: "processing", rail }).where(eq(disbursements.id, id));
    }
    return { done: false as const, d, rail, acct };
  });
  if (claim.done) return { status: "succeeded" as const };

  const { d, rail, acct } = claim;
  const res = await gw.payments.payout({ idempotencyKey: `${d.idempotencyKey}:${d.attempts}`, amount: d.amount, ifsc: acct.ifsc, account: acct.accountNumber, rail });
  if (res.status === "succeeded") { await finalize(db, d, res.bankRef, now, gw); return { status: "succeeded" as const }; }
  if (res.status === "failed") { await fail(db, d, res.reason ?? `${rail} failed`, gw); return { status: "failed" as const }; }
  await db.update(disbursements).set({ bankRef: res.bankRef }).where(eq(disbursements.id, id));
  return { status: "processing" as const }; // webhook or poll settles it
}

/** Provider webhook / poller outcome for an in-flight payout. Idempotent. */
export async function settleDisbursement(db: Database, bankRef: string, outcome: "succeeded" | "failed", reason?: string, gw: Adapters = gateway, now = new Date()) {
  const [d] = await db.select().from(disbursements).where(eq(disbursements.bankRef, bankRef));
  if (!d) throw new Error("unknown payout reference");
  if (d.status === "succeeded") return { status: "succeeded" as const };
  if (d.status !== "processing") throw new Error(`disbursement is ${d.status}`);
  if (outcome === "succeeded") await finalize(db, d, bankRef, now, gw);
  else await fail(db, d, reason ?? "payout failed", gw);
  return { status: outcome };
}

/** Webhook-miss fallback (PRD 12.1): ask the provider about anything still processing. */
export async function pollProcessing(db: Database, gw: Adapters = gateway) {
  const rows = await db.select().from(disbursements).where(eq(disbursements.status, "processing"));
  let settled = 0;
  for (const d of rows) {
    if (!d.bankRef) continue;
    const s = await gw.payments.payoutStatus(d.bankRef);
    if (s !== "processing") { await settleDisbursement(db, d.bankRef, s, undefined, gw); settled++; }
  }
  return settled;
}

/** Ops re-queue after the automatic attempts are exhausted. Uses the next rail/key; never reuses a failed attempt's key. */
export async function retryDisbursement(db: Database, id: string, staff: { id: string; role: string }) {
  if (!STAFF.includes(staff.role)) throw new Error("forbidden");
  const [d] = await db.update(disbursements).set({ status: "pending", makerId: staff.id, failureReason: null })
    .where(and(eq(disbursements.id, id), eq(disbursements.status, "failed"))).returning();
  if (!d) throw new Error("only failed disbursements can be retried");
  await db.insert(auditLog).values({ actorId: staff.id, action: "disbursement.retry", entity: "disbursement", entityId: id });
}

/** Worker: queue payouts for fully-signed offers, then send everything that's cleared to go. Failures are isolated. */
export async function runDisbursements(db: Database, gw: Adapters = gateway) {
  try { await assertPreviousDayReconciled(db, isoDay(new Date())); } // no new money moves until yesterday ties out (RECON_GATE=on)
  catch (e) { console.error("[disburse]", (e as Error).message); return 0; }
  const ready = await db.select({ id: financingOffers.id }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(financingOffers.status, "accepted"), eq(invoices.status, "eligible")));
  for (const o of ready) { try { await requestDisbursement(db, o.id); } catch { /* not ready yet (unsigned etc.) */ } }

  const due = await db.select().from(disbursements).where(inArray(disbursements.status, ["pending", "failed"]));
  let sent = 0;
  for (const d of due) {
    if (d.status === "failed" && d.attempts >= DISBURSE.autoAttempts) continue; // ops queue
    if (d.status === "failed") await db.update(disbursements).set({ status: "pending" }).where(eq(disbursements.id, d.id)); // auto-retry on the alternate rail
    try { const r = await executeDisbursement(db, d.id, gw); if (r.status === "succeeded") sent++; }
    catch (e) { console.error("[disburse]", d.id, (e as Error).message); }
  }
  await pollProcessing(db, gw);
  return sent;
}
