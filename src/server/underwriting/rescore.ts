// Periodic review of every seller's credit limit (PRD Module 5: re-score active limits as repayment data accumulates).
// The rule is plain and explainable: a late payment lowers the limit, a clean record with a well-used limit raises it, anything else
// leaves it alone. A limit never drops below what is already outstanding and never grows past a set multiple of the default.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, limitReviews } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness } from "../notify";
import { formatMoney } from "../../lib/money";
import { POLICY } from "./policy";
import { behaviour } from "./service";

const DAY = 86_400_000;
const round = (v: bigint) => (v / 100_000n) * 100_000n; // to a whole 1,000 of the currency

/** What a seller's limit should become, and why. Pure, so the rule can be read and tested. */
export function reviewLimit(p: { current: bigint; outstanding: bigint; paidCount: number; overdueCount: number; maxDpd: number }): { next: bigint; reason: string } {
  const step = BigInt(POLICY.limitStepBps);
  const ceiling = POLICY.defaultSellerLimit * BigInt(POLICY.maxLimitMultiple);
  const floor = (v: bigint) => (v < p.outstanding ? p.outstanding : v); // never below what is already out
  if (p.maxDpd > 30) return { next: floor(round((p.current * (10_000n - 2n * step)) / 10_000n)), reason: `Lowered: an invoice is ${p.maxDpd >= 999 ? "written off" : `${p.maxDpd} days late`}` };
  if (p.overdueCount > 0) return { next: floor(round((p.current * (10_000n - step)) / 10_000n)), reason: "Lowered: an invoice is overdue" };
  const used = p.current > 0n ? Number((p.outstanding * 100n) / p.current) : 0;
  if (p.paidCount >= 3 && used >= 50) {
    const up = round((p.current * (10_000n + step)) / 10_000n);
    const next = up > ceiling ? ceiling : up;
    if (next > p.current) return { next, reason: `Raised: ${p.paidCount} invoices repaid on time and ${used}% of the limit is in use` };
  }
  return { next: p.current, reason: "No change" };
}

/** Review the sellers that are due. Each is looked at once per period; new sellers wait for a first period of history. */
export async function rescoreLimits(db: Database, gw: Adapters = gateway, now = new Date(), limit = 200) {
  const due = POLICY.rescoreDays * DAY;
  const sellers = await db.select().from(businesses).where(and(eq(businesses.kind, "seller"), eq(businesses.kybStatus, "approved")))
    .orderBy(sql`${businesses.createdAt} asc`).limit(limit * 5);
  const out = { reviewed: 0, raised: 0, lowered: 0 };
  for (const s of sellers) {
    if (out.reviewed >= limit) break;
    const [last] = await db.select({ at: limitReviews.createdAt }).from(limitReviews).where(eq(limitReviews.businessId, s.id)).orderBy(desc(limitReviews.createdAt)).limit(1);
    const since = last?.at ?? s.kybApprovedAt ?? s.createdAt;
    if (now.getTime() - since.getTime() < due) continue;
    const b = await behaviour(db, { col: "sellerId", id: s.id }, now);
    const current = s.creditLimit > 0n ? s.creditLimit : POLICY.defaultSellerLimit;
    const { next, reason } = reviewLimit({ current, outstanding: b.outstanding, paidCount: b.paidCount, overdueCount: b.overdueCount, maxDpd: b.maxDpd });
    await db.transaction(async (tx) => {
      await tx.insert(limitReviews).values({ businessId: s.id, before: current, after: next, reason, createdAt: now });
      if (next !== current) {
        await tx.update(businesses).set({ creditLimit: next }).where(eq(businesses.id, s.id));
        await tx.insert(auditLog).values({ action: "limit.reviewed", entity: "business", entityId: s.id, before: { limit: current.toString() }, after: { limit: next.toString(), reason } });
      }
    });
    out.reviewed++;
    if (next !== current) {
      next > current ? out.raised++ : out.lowered++;
      await notifyBusiness(db, s.id, "limit_changed", { from: formatMoney(current), to: formatMoney(next), reason }, gw, now);
    }
  }
  return out;
}
