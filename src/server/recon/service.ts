import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { bankStatementLines, disbursements, reconciliationRuns, sellerPayouts } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyStaff } from "../notify";

type Row = Record<string, string>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const prevDay = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) - 1)).toISOString().slice(0, 10);

/** Pull the day's escrow statement from the bank feed and store it. Idempotent on (reference, direction). */
export async function ingestStatement(db: Database, date: string, gw: Adapters = gateway) {
  const lines = await gw.statements.fetch(date);
  for (const l of lines) {
    await db.insert(bankStatementLines).values({
      statementDate: date, reference: l.reference, direction: l.direction, amount: l.amount, narration: l.narration,
    }).onConflictDoNothing();
  }
  return lines.length;
}

export type Exception = { kind: "amount_mismatch" | "no_ledger_entry" | "missing_in_bank"; reference: string; bank?: string; ledger?: string };

/**
 * End-of-day reconciliation of the escrow account (PRD Module 10): every bank line must match a ledger
 * transaction for the same amount, and every escrow ledger movement of the day must appear at the bank.
 * `variance` = bank net movement - ledger escrow net movement. The day is `tied` only at zero variance and zero exceptions.
 * Re-runnable: it recomputes from scratch each time.
 */
export async function reconcileDay(db: Database, date: string, gw: Adapters = gateway) {
  const lines = await db.select().from(bankStatementLines).where(eq(bankStatementLines.statementDate, date));

  // Ledger side: escrow movement per transaction created on this UTC date (debit = money in, credit = money out).
  const ledger = rowsOf(await db.execute(sql`
    select t.ref, sum(case when e.direction = 'debit' then e.amount else -e.amount end)::text as net
    from ledger_entries e
    join ledger_transactions t on t.id = e.transaction_id
    join ledger_accounts a on a.id = e.account_id and a.code = 'escrow_cash'
    where (t.created_at at time zone 'UTC')::date = ${date}::date
    group by t.ref`));
  const ledgerNetByRef = new Map(ledger.map((r) => [r.ref, BigInt(r.net)]));
  const ledgerNet = [...ledgerNetByRef.values()].reduce((a, b) => a + b, 0n);

  // A bank reference can name a ledger transaction directly (e.g. funding), a UTR (repayment), or a payout's bank ref.
  const refs = lines.map((l) => l.reference);
  const disb = refs.length ? await db.select({ id: disbursements.id, bankRef: disbursements.bankRef }).from(disbursements).where(inArray(disbursements.bankRef, refs)) : [];
  const surp = refs.length ? await db.select({ id: sellerPayouts.id, bankRef: sellerPayouts.bankRef }).from(sellerPayouts).where(inArray(sellerPayouts.bankRef, refs)) : [];
  const candidates = (ref: string) => [
    ref, `repay:${ref}`,
    ...disb.filter((d) => d.bankRef === ref).map((d) => `disb:${d.id}`),
    ...surp.filter((s) => s.bankRef === ref).map((s) => `surplus:${s.id}`),
  ];

  const exceptions: Exception[] = [];
  const matchedLedgerRefs = new Set<string>();
  let bankNet = 0n;
  for (const l of lines) {
    const signed = l.direction === "credit" ? l.amount : -l.amount;
    bankNet += signed;
    const hit = candidates(l.reference).find((c) => ledgerNetByRef.has(c));
    let status = "matched", exception: string | null = null;
    if (!hit) {
      status = "exception"; exception = "no_ledger_entry";
      exceptions.push({ kind: "no_ledger_entry", reference: l.reference, bank: signed.toString() });
    } else if (ledgerNetByRef.get(hit) !== signed) {
      status = "exception"; exception = "amount_mismatch";
      exceptions.push({ kind: "amount_mismatch", reference: l.reference, bank: signed.toString(), ledger: ledgerNetByRef.get(hit)!.toString() });
      matchedLedgerRefs.add(hit);
    } else matchedLedgerRefs.add(hit);
    await db.update(bankStatementLines).set({ status, exception, ledgerTxRef: hit ?? null }).where(eq(bankStatementLines.id, l.id));
  }
  for (const [ref, net] of ledgerNetByRef) {
    if (!matchedLedgerRefs.has(ref)) exceptions.push({ kind: "missing_in_bank", reference: ref, ledger: net.toString() });
  }

  const variance = bankNet - ledgerNet;
  const status = variance === 0n && exceptions.length === 0 ? "tied" : "variance";
  const run = { date, status, bankNet, ledgerNet, variance, exceptions, ranAt: new Date() };
  await db.insert(reconciliationRuns).values(run).onConflictDoUpdate({ target: reconciliationRuns.date, set: run });
  if (status === "variance") {
    await notifyStaff(db, ["ops", "admin"], "reconciliation_variance", { date, variance: variance.toString(), exceptions: String(exceptions.length) }, gw);
  }
  return run;
}

/** Worker entry: fetch today's statement, then reconcile. */
export async function runReconciliation(db: Database, date: string, gw: Adapters = gateway) {
  await ingestStatement(db, date, gw);
  return reconcileDay(db, date, gw);
}

/**
 * Gate for "next-day processing opens only after zero variance". Off by default so a dev/mock environment with no bank
 * feed isn't blocked; set RECON_GATE=on in production. A day with no escrow movement needs no reconciliation.
 */
export async function assertPreviousDayReconciled(db: Database, today: string) {
  if (process.env.RECON_GATE !== "on") return;
  const prev = prevDay(today);
  const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.date, prev));
  if (run) {
    if (run.status !== "tied") throw new Error(`RECONCILIATION_REQUIRED: ${prev} has unresolved variance`);
    return;
  }
  const [{ n }] = rowsOf(await db.execute(sql`
    select count(*)::text as n from ledger_entries e
    join ledger_transactions t on t.id = e.transaction_id
    join ledger_accounts a on a.id = e.account_id and a.code = 'escrow_cash'
    where (t.created_at at time zone 'UTC')::date = ${prev}::date`));
  if (Number(n) > 0) throw new Error(`RECONCILIATION_REQUIRED: ${prev} has not been reconciled`);
}
