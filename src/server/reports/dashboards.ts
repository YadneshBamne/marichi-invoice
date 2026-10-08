import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agreements, businesses, buyerSellerRelationships, disbursements, financingOffers, fraudCases, invoiceCollections, invoiceDisputes, invoices,
  reconciliationRuns, repayments, tickets, underwritingDecisions, unmatchedCredits,
} from "../db/schema";
import { bucketOf, daysBetween, isoDay, type Bucket } from "../collections/waterfall";
import { ACCOUNTS, balance } from "../ledger/accounts";
import { platformCapital } from "../offers/pricing";
import { POLICY } from "../underwriting/policy";

// ponytail: aggregates are computed in JS from plain selects. Fine at MVP volumes; move to SQL aggregates/materialised
// views (or the Phase 3 warehouse) when a single business has thousands of invoices or the ops view gets slow.

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const OPEN_STATUSES = ["financed", "due", "overdue"] as const;
const dayKey = (d: Date) => isoDay(d);
const lastNDays = (now: Date, n: number) => Array.from({ length: n }, (_, i) => isoDay(new Date(now.getTime() - (n - 1 - i) * 86_400_000)));
export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------- seller

export async function sellerDashboard(db: Database, businessId: string, now = new Date()) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const invs = await db.select().from(invoices).where(eq(invoices.sellerId, businessId));
  const ids = invs.map((i) => i.id);

  const open = ids.length
    ? await db.select({ c: invoiceCollections, i: invoices, buyer: businesses.legalName }).from(invoiceCollections)
        .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).innerJoin(businesses, eq(businesses.id, invoices.buyerId))
        .where(and(eq(invoices.sellerId, businessId), isNull(invoiceCollections.closedAt)))
    : [];
  const funded = await db.select({ d: disbursements, o: financingOffers, i: invoices }).from(disbursements)
    .innerJoin(financingOffers, eq(financingOffers.id, disbursements.offerId)).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(invoices.sellerId, businessId), eq(disbursements.status, "succeeded"))).orderBy(desc(disbursements.completedAt));
  const reps = ids.length ? await db.select().from(repayments).where(inArray(repayments.invoiceId, ids)) : [];

  const limit = biz.creditLimit > 0n ? biz.creditLimit : POLICY.defaultSellerLimit;
  const outstanding = sum(open.map((r) => r.c.principal));
  const days = lastNDays(now, 7);
  const byDay = new Map<string, bigint>();
  for (const f of funded) if (f.d.completedAt) byDay.set(dayKey(f.d.completedAt), (byDay.get(dayKey(f.d.completedAt)) ?? 0n) + f.d.amount);
  const discountPaid = sum(reps.map((r) => BigInt((r.allocation as { discount?: string } | null)?.discount ?? "0")));

  const pipeline: Record<string, number> = {};
  for (const i of invs) pipeline[i.status] = (pipeline[i.status] ?? 0) + 1;

  const [openOffers, toSign, openTickets, openDisputes] = await Promise.all([
    ids.length ? db.select({ id: financingOffers.id }).from(financingOffers).where(and(inArray(financingOffers.invoiceId, ids), eq(financingOffers.status, "open"))) : [],
    db.select({ id: agreements.id }).from(agreements).where(and(eq(agreements.businessId, businessId), eq(agreements.status, "sent"), inArray(agreements.kind, ["master", "invoice_schedule"]))),
    db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.businessId, businessId), inArray(tickets.status, ["open", "in_progress", "awaiting_customer"]))),
    ids.length ? db.select({ id: invoiceDisputes.id }).from(invoiceDisputes).where(and(inArray(invoiceDisputes.invoiceId, ids), eq(invoiceDisputes.status, "open"))) : [],
  ]);

  const [{ n: buyersLinked }] = await db.select({ n: sql<number>`count(*)::int` }).from(buyerSellerRelationships).where(eq(buyerSellerRelationships.sellerId, businessId));
  const today = isoDay(now);
  return {
    kyb: biz.kybStatus,
    // Drives the "Get started" checklist: each flag flips when the seller has done that step.
    setup: { verified: biz.kybStatus === "approved", buyer: buyersLinked > 0, invoice: invs.length > 0, funded: funded.length > 0 },
    limit, outstanding, available: limit > outstanding ? limit - outstanding : 0n,
    financedToDate: sum(funded.map((f) => f.o.advanceAmount)),
    feesPaid: sum(funded.map((f) => f.o.feeAmount)) + discountPaid,
    overdue: open.filter((r) => daysBetween(r.i.dueDate, today) > 0).length,
    funding7d: days.map((d) => ({ date: d, amount: byDay.get(d) ?? 0n })),
    pipeline,
    upcoming: open.map((r) => ({ invoiceId: r.i.id, number: r.i.invoiceNumber, buyer: r.buyer, due: r.i.dueDate, amount: r.i.amount, dpd: Math.max(0, daysBetween(r.i.dueDate, today)) }))
      .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6),
    recent: funded.slice(0, 5).map((f) => ({ number: f.i.invoiceNumber, amount: f.d.amount, at: f.d.completedAt })),
    attention: { offers: openOffers.length, toSign: toSign.length, tickets: openTickets.length, disputes: openDisputes.length },
  };
}

// ---------------------------------------------------------------- buyer

export async function buyerDashboard(db: Database, businessId: string, now = new Date()) {
  const [biz] = await db.select({ kyb: businesses.kybStatus }).from(businesses).where(eq(businesses.id, businessId));
  const invs = await db.select({ i: invoices, seller: businesses.legalName }).from(invoices)
    .innerJoin(businesses, eq(businesses.id, invoices.sellerId)).where(eq(invoices.buyerId, businessId));
  const today = isoDay(now);
  const pending = invs.filter((r) => r.i.status === "sent_for_confirmation");
  const payables = invs.filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.i.status));
  const in30 = payables.filter((r) => { const d = daysBetween(today, r.i.dueDate); return d >= 0 && d <= 30; });
  const overdue = payables.filter((r) => daysBetween(r.i.dueDate, today) > 0);
  const rels = await db.select({ r: buyerSellerRelationships, seller: businesses.legalName }).from(buyerSellerRelationships)
    .innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.sellerId)).where(eq(buyerSellerRelationships.buyerId, businessId));

  const suppliers = rels.map(({ r, seller }) => {
    const mine = invs.filter((x) => x.i.sellerId === r.sellerId);
    const financed = mine.filter((x) => ["financed", "due", "overdue", "paid"].includes(x.i.status));
    return { seller, invoices: mine.length, volume: sum(financed.map((x) => x.i.amount)), terms: r.creditTermsDays };
  }).sort((a, b) => (b.volume > a.volume ? 1 : -1));

  return {
    kyb: biz.kyb,
    pendingCount: pending.length, pendingValue: sum(pending.map((r) => r.i.amount)),
    due30Value: sum(in30.map((r) => r.i.amount)), due30Count: in30.length,
    overdueCount: overdue.length, overdueValue: sum(overdue.map((r) => r.i.amount)),
    suppliers,
    awaiting: pending.map((r) => ({ id: r.i.id, number: r.i.invoiceNumber, seller: r.seller, amount: r.i.amount, due: r.i.dueDate })).slice(0, 6),
    upcoming: payables.map((r) => ({ id: r.i.id, number: r.i.invoiceNumber, seller: r.seller, amount: r.i.amount, due: r.i.dueDate, dpd: Math.max(0, daysBetween(r.i.dueDate, today)) }))
      .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6),
  };
}

// ---------------------------------------------------------------- operations / management

export async function opsDashboard(db: Database, now = new Date()) {
  const today = isoDay(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since30 = new Date(now.getTime() - 30 * 86_400_000);

  const funded = await db.select({ d: disbursements, o: financingOffers, i: invoices }).from(disbursements)
    .innerJoin(financingOffers, eq(financingOffers.id, disbursements.offerId)).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(eq(disbursements.status, "succeeded"));
  const gtv = (from: Date, to: Date) => sum(funded.filter((f) => f.d.completedAt && f.d.completedAt >= from && f.d.completedAt < to).map((f) => f.o.advanceAmount));
  const months = Array.from({ length: 6 }, (_, k) => {
    const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - k), 1)), e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
    return { label: s.toLocaleString("en-IN", { month: "short", timeZone: "UTC" }), amount: gtv(s, e) };
  });
  const gtvMonth = gtv(monthStart, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
  const gtvPrev = gtv(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), monthStart);

  const open = await db.select({ c: invoiceCollections, i: invoices }).from(invoiceCollections)
    .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).where(isNull(invoiceCollections.closedAt));
  const buckets: Record<Bucket, bigint> = { "0": 0n, "1-30": 0n, "31-60": 0n, "61-90": 0n, "90+": 0n };
  for (const r of open) buckets[bucketOf(daysBetween(r.i.dueDate, today))] += r.c.principal;
  const book = sum(open.map((r) => r.c.principal));
  const npaPct = book > 0n ? Number((sum([buckets["31-60"], buckets["61-90"], buckets["90+"]]) * 10_000n) / book) / 100 : 0; // % of book 30+ DPD

  // Funnel (last 30 days of uploads): upload -> confirmed -> offered -> accepted -> funded.
  const recent = await db.select().from(invoices).where(sql`${invoices.createdAt} >= ${since30.toISOString()}::timestamptz`);
  const rid = recent.map((i) => i.id);
  const offers = rid.length ? await db.select().from(financingOffers).where(inArray(financingOffers.invoiceId, rid)) : [];
  const fundedIds = new Set(funded.map((f) => f.i.id));
  const funnel = {
    uploaded: recent.length,
    confirmed: recent.filter((i) => i.confirmedAt).length,
    offered: new Set(offers.map((o) => o.invoiceId)).size,
    accepted: new Set(offers.filter((o) => o.acceptedAt).map((o) => o.invoiceId)).size,
    funded: recent.filter((i) => fundedIds.has(i.id)).length,
  };

  // Turnaround, in hours (PRD KPI): upload -> buyer confirmation, and confirmation -> money out.
  const h = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
  const tatConfirm = median(recent.filter((i) => i.confirmedAt).map((i) => h(i.createdAt, i.confirmedAt!)));
  const tatPayout = median(funded.filter((f) => f.i.confirmedAt && f.d.completedAt).map((f) => h(f.i.confirmedAt!, f.d.completedAt!)));

  const capital = platformCapital();
  const [{ deployed }] = await db.select({ deployed: sql<string>`coalesce(sum(${financingOffers.advanceAmount}), 0)` }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(financingOffers.status, "accepted"), inArray(invoices.status, ["eligible", "financed", "due", "overdue"])));

  const [kyb, referred, fraud, breached, unmatched, failed, needsApproval, recon, ticketsOpen] = await Promise.all([
    db.select({ id: businesses.id }).from(businesses).where(inArray(businesses.kybStatus, ["under_review", "submitted"])),
    db.select({ id: underwritingDecisions.id }).from(underwritingDecisions).innerJoin(invoices, eq(invoices.id, underwritingDecisions.invoiceId)).where(and(eq(underwritingDecisions.decision, "referred"), eq(invoices.status, "eligible"))),
    db.select({ sev: fraudCases.severity }).from(fraudCases).where(eq(fraudCases.status, "open")),
    db.select({ id: tickets.id }).from(tickets).where(and(inArray(tickets.status, ["open", "in_progress", "awaiting_customer"]), or(sql`${tickets.slaBreachedAt} is not null`, sql`${tickets.frBreachedAt} is not null`))),
    db.select({ id: unmatchedCredits.id }).from(unmatchedCredits).where(isNull(unmatchedCredits.resolvedAt)),
    db.select({ id: disbursements.id }).from(disbursements).where(eq(disbursements.status, "failed")),
    db.select({ id: disbursements.id }).from(disbursements).where(and(eq(disbursements.status, "pending"), eq(disbursements.needsApproval, true), isNull(disbursements.approvedAt))),
    db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.date)).limit(1),
    db.select({ id: tickets.id }).from(tickets).where(inArray(tickets.status, ["open", "in_progress", "awaiting_customer"])),
  ]);

  return {
    gtvMonth, gtvPrev, gtvChangePct: gtvPrev > 0n ? Math.round((Number(gtvMonth - gtvPrev) / Number(gtvPrev)) * 100) : null, months,
    book, openInvoices: open.length, buckets, npaPct,
    funnel, tatConfirmHours: tatConfirm, tatPayoutHours: tatPayout,
    capital, deployed: BigInt(deployed), utilizationPct: capital > 0n ? Math.round(Number((BigInt(deployed) * 1000n) / capital)) / 10 : 0,
    escrow: await balance(db, ACCOUNTS.escrow),
    queues: { kyb: kyb.length, underwriting: referred.length, unmatched: unmatched.length, failedPayouts: failed.length, approvals: needsApproval.length, ticketsOpen: ticketsOpen.length, ticketsBreached: breached.length },
    fraud: { open: fraud.length, high: fraud.filter((f) => f.sev === "high").length },
    recon: recon[0] ? { date: recon[0].date, status: recon[0].status } : null,
  };
}
