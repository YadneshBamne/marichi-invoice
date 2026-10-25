// Tax held back from financiers' earnings (TDS in India, withholding tax in Zambia). Staff set the rate for each financier from its tax
// status (0 or none for one with an exemption certificate). From then on every repayment that carries earnings holds that share back
// into the tax-payable account instead of the financier's funds; staff pay it over to the tax authority and record it here.
// Rates and who must be charged are tax advice: counsel and the tax adviser confirm them per country before this is switched on.
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, financierProfiles, tdsWithheld } from "../db/schema";
import { ACCOUNTS, balance, ensureAccounts } from "../ledger/accounts";
import { postEntry } from "../ledger/post";

const STAFF = ["ops", "compliance", "admin"];

/** Set (or clear, with null) the share of a financier's earnings that is held back. Applies to repayments from now on. */
export async function setFinancierTds(db: Database, staff: { id: string; role: string }, financierId: string, rateBps: number | null, note: string) {
  if (!STAFF.includes(staff.role)) throw new Error("forbidden");
  if (rateBps !== null && (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 4000)) throw new Error("the rate must be from 0% to 40%");
  if (note.trim().length < 5) throw new Error("say why (for example, its tax status or exemption certificate)");
  const [p] = await db.select().from(financierProfiles).where(eq(financierProfiles.businessId, financierId));
  if (!p) throw new Error("that company has no financier application");
  const next = rateBps && rateBps > 0 ? rateBps : null;
  await db.update(financierProfiles).set({ tdsBps: next }).where(eq(financierProfiles.businessId, financierId));
  await db.insert(auditLog).values({ actorId: staff.id, action: "financier.tds_set", entity: "business", entityId: financierId, before: { tdsBps: p.tdsBps }, after: { tdsBps: next, note: note.trim() } });
}

/** What is owed to the tax authority right now: held back, not yet paid over. */
export const taxPayable = async (db: Database) => -(await balance(db, ACCOUNTS.tdsPayable));

/** Held back per financier in a period (the base for each one's tax certificate). */
export async function tdsReport(db: Database, from: Date, to: Date) {
  return db.select({ financierId: tdsWithheld.financierId, name: businesses.legalName, base: sql<string>`sum(${tdsWithheld.base})`, amount: sql<string>`sum(${tdsWithheld.amount})`, n: sql<number>`count(*)::int` })
    .from(tdsWithheld).innerJoin(businesses, eq(businesses.id, tdsWithheld.financierId))
    .where(and(gte(tdsWithheld.createdAt, from), lt(tdsWithheld.createdAt, to))).groupBy(tdsWithheld.financierId, businesses.legalName).orderBy(businesses.legalName)
    .then((rows) => rows.map((r) => ({ ...r, base: BigInt(r.base), amount: BigInt(r.amount) })));
}

export const recentTds = (db: Database, limit = 30) =>
  db.select({ t: tdsWithheld, name: businesses.legalName }).from(tdsWithheld).innerJoin(businesses, eq(businesses.id, tdsWithheld.financierId)).orderBy(desc(tdsWithheld.createdAt)).limit(limit);

/** Record that tax held back was paid over to the authority. It leaves escrow and clears the payable. Only what is actually owed can be paid. */
export async function recordTdsRemittance(db: Database, staff: { id: string; role: string }, p: { amount: bigint; ref: string; note?: string }) {
  if (!STAFF.includes(staff.role)) throw new Error("forbidden");
  if (p.amount <= 0n) throw new Error("amount must be positive");
  if (!p.ref.trim()) throw new Error("enter the payment reference");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7003)`);
    if ((await taxPayable(tx as unknown as Database)) < p.amount) throw new Error("that is more than is owed to the tax authority");
    await ensureAccounts(tx, [ACCOUNTS.tdsPayable, ACCOUNTS.escrow]);
    const r = await postEntry(tx, { ref: `tds-paid:${p.ref.trim()}`, type: "tds_remittance", lines: [
      { account: ACCOUNTS.tdsPayable, direction: "debit", amount: p.amount },
      { account: ACCOUNTS.escrow, direction: "credit", amount: p.amount },
    ] });
    if (!r.replayed) await tx.insert(auditLog).values({ actorId: staff.id, action: "tds.remitted", entity: "ledger", entityId: r.id, after: { amount: p.amount.toString(), ref: p.ref.trim(), note: p.note ?? null } });
    return r;
  });
}
