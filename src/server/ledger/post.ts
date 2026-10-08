import { eq, inArray } from "drizzle-orm";
import type { Tx } from "../db/client";
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from "../db/schema";

export type Line = { account: string; direction: "debit" | "credit"; amount: bigint };

/** Pure check, also enforced by a deferred DB trigger (drizzle/ custom SQL). */
export function assertBalanced(lines: Line[]) {
  if (lines.length < 2) throw new Error("ledger: need at least 2 lines");
  let net = 0n;
  for (const l of lines) {
    if (l.amount <= 0n) throw new Error("ledger: amounts must be > 0 paise");
    net += l.direction === "debit" ? l.amount : -l.amount;
  }
  if (net !== 0n) throw new Error(`ledger: unbalanced by ${net} paise`);
}

/**
 * Post one balanced transaction. Idempotent on `ref`: replaying the same ref is a no-op.
 * Corrections are a new reversing transaction, never an update (PRD Module 10).
 */
export async function postEntry(
  tx: Tx,
  t: { ref: string; type: string; lines: Line[]; reversesId?: string },
) {
  assertBalanced(t.lines);
  const [row] = await tx
    .insert(ledgerTransactions)
    .values({ ref: t.ref, type: t.type, reversesId: t.reversesId })
    .onConflictDoNothing({ target: ledgerTransactions.ref })
    .returning({ id: ledgerTransactions.id });
  if (!row) {
    const [existing] = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.ref, t.ref));
    return { id: existing.id, replayed: true };
  }
  const codes = [...new Set(t.lines.map((l) => l.account))];
  const accts = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.code, codes));
  const byCode = new Map(accts.map((a) => [a.code, a.id]));
  for (const c of codes) if (!byCode.has(c)) throw new Error(`ledger: unknown account ${c}`);
  await tx.insert(ledgerEntries).values(
    t.lines.map((l) => ({
      transactionId: row.id,
      accountId: byCode.get(l.account)!,
      direction: l.direction,
      amount: l.amount,
    })),
  );
  return { id: row.id, replayed: false };
}
