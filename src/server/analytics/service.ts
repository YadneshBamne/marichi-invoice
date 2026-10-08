// Analytics and scheduled reports. Everything here is read-only over data the platform already holds.
// ponytail: aggregates are computed in JS from plain selects, like the dashboards. Move to SQL/materialised views when one book gets large.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { businesses, disbursements, financingOffers, invoiceCollections, invoices, repayments, reportRuns, reportSchedules } from "../db/schema";
import { daysBetween, isoDay } from "../collections/waterfall";
import { notifyUser } from "../notify";
import { gateway, type Adapters } from "../integrations/gateway";
import { toCsv } from "../ledger/reports";
import { toDecimal } from "../../lib/money";
import { financierShare } from "../marketplace/service";

export type Scope = { role: string; businessId: string | null };
const month = (d: Date) => d.toISOString().slice(0, 7);
const alloc = (a: unknown, k: string) => BigInt((a as Record<string, string> | null)?.[k] ?? "0");

/** Everything funded, one row per invoice, with what has come back. The base for vintages and portfolio views. */
async function funded(db: Database, scope: Scope) {
  const q = db.select({ d: disbursements, o: financingOffers, i: invoices, c: invoiceCollections }).from(disbursements)
    .innerJoin(financingOffers, eq(financingOffers.id, disbursements.offerId))
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .leftJoin(invoiceCollections, eq(invoiceCollections.invoiceId, invoices.id));
  const where = eq(disbursements.status, "succeeded");
  const rows = scope.role === "seller" ? await q.where(and(where, eq(invoices.sellerId, scope.businessId!)))
    : scope.role === "financier" ? await q.where(and(where, eq(financingOffers.financierId, scope.businessId!)))
    : scope.role === "buyer" ? await q.where(and(where, eq(invoices.buyerId, scope.businessId!)))
    : await q.where(where);
  const ids = rows.map((r) => r.i.id);
  const reps = ids.length ? await db.select().from(repayments).where(inArray(repayments.invoiceId, ids)) : [];
  const repaid = new Map<string, { principal: bigint; discount: bigint; penal: bigint }>();
  for (const r of reps) {
    const e = repaid.get(r.invoiceId) ?? { principal: 0n, discount: 0n, penal: 0n };
    e.principal += alloc(r.allocation, "principal"); e.discount += alloc(r.allocation, "discount"); e.penal += alloc(r.allocation, "penal");
    repaid.set(r.invoiceId, e);
  }
  return rows.map((r) => ({ ...r, paid: repaid.get(r.i.id) ?? { principal: 0n, discount: 0n, penal: 0n } }));
}

/** Vintage analysis: group by the month money went out and follow each group's repayment and delinquency over time. */
export async function vintages(db: Database, scope: Scope, now = new Date()) {
  const by = new Map<string, { month: string; invoices: number; advanced: bigint; repaid: bigint; outstanding: bigint; late30: bigint; lost: bigint; earned: bigint }>();
  for (const r of await funded(db, scope)) {
    const m = month(r.d.completedAt ?? r.d.createdAt);
    const e = by.get(m) ?? { month: m, invoices: 0, advanced: 0n, repaid: 0n, outstanding: 0n, late30: 0n, lost: 0n, earned: 0n };
    e.invoices++; e.advanced += r.o.advanceAmount; e.repaid += r.paid.principal; e.earned += r.paid.discount + r.paid.penal;
    const open = r.c && !r.c.closedAt ? r.c.principal : 0n;
    e.outstanding += open;
    if (open > 0n && daysBetween(r.i.dueDate, isoDay(now)) >= 30) e.late30 += open;
    if (r.i.status === "written_off") e.lost += r.o.advanceAmount - r.paid.principal;
    by.set(m, e);
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month)).map((e) => ({
    ...e,
    repaidPct: e.advanced > 0n ? Number((e.repaid * 10_000n) / e.advanced) / 100 : 0,
    late30Pct: e.advanced > 0n ? Number((e.late30 * 10_000n) / e.advanced) / 100 : 0,
    lossPct: e.advanced > 0n ? Number((e.lost * 10_000n) / e.advanced) / 100 : 0,
  }));
}

/** Who the open book depends on. HHI is the sum of squared shares (0 to 10,000); above 2,500 is highly concentrated. */
export async function concentration(db: Database, scope: Scope) {
  const rows = (await funded(db, scope)).filter((r) => r.c && !r.c.closedAt && r.c.principal > 0n);
  const total = rows.reduce((a, r) => a + r.c!.principal, 0n);
  const names = new Map((await db.select({ id: businesses.id, n: businesses.legalName }).from(businesses)).map((b) => [b.id, b.n]));
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, bigint>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0n) + r.c!.principal);
    const list = [...m.entries()].map(([id, v]) => ({ name: names.get(id) ?? "?", exposure: v, share: total > 0n ? Number((v * 10_000n) / total) / 100 : 0 })).sort((a, b) => Number(b.exposure - a.exposure));
    return { top: list.slice(0, 5), hhi: Math.round(list.reduce((a, x) => a + x.share * x.share, 0)), count: list.length };
  };
  return { total, byBuyer: group((r) => r.i.buyerId), bySeller: group((r) => r.i.sellerId) };
}

export type Forecast = { columns: string[]; overdue: Record<string, bigint>; weeks: { start: string; values: Record<string, bigint> }[] };

/**
 * What is expected to move, week by week from today, for the next `weeks` weeks. Money already past its due date is shown separately.
 *  seller: what your buyers should pay you (net of any advance you were given)   buyer: what you owe, by due date
 *  financier: principal and your share of discount coming back                   staff: collections due on the whole book
 */
export async function forecast(db: Database, scope: Scope, now = new Date(), weeks = 12): Promise<Forecast> {
  const live = ["eligible", "financed", "due", "overdue"] as const;
  const where = scope.role === "seller" ? eq(invoices.sellerId, scope.businessId!) : scope.role === "buyer" ? eq(invoices.buyerId, scope.businessId!) : undefined;
  const rows = await db.select({ i: invoices, o: financingOffers, c: invoiceCollections }).from(invoices)
    .leftJoin(financingOffers, and(eq(financingOffers.invoiceId, invoices.id), eq(financingOffers.status, "accepted")))
    .leftJoin(invoiceCollections, and(eq(invoiceCollections.invoiceId, invoices.id), isNull(invoiceCollections.closedAt)))
    .where(and(inArray(invoices.status, [...live]), where));
  const columns = scope.role === "seller" ? ["Buyer pays you", "Buyer pays, net of your advance"] : scope.role === "buyer" ? ["You owe"] : scope.role === "financier" ? ["Principal back", "Your share of discount"] : ["Principal", "Discount"];
  const today = isoDay(now);
  const out: Forecast = { columns, overdue: Object.fromEntries(columns.map((c) => [c, 0n])), weeks: Array.from({ length: weeks }, (_, w) => ({ start: isoDay(new Date(now.getTime() + w * 7 * 86_400_000)), values: Object.fromEntries(columns.map((c) => [c, 0n])) })) };
  for (const { i, o, c } of rows) {
    const add: Record<string, bigint> = {};
    if (scope.role === "seller") {
      if (o && c) add["Buyer pays, net of your advance"] = i.amount > c.principal + o.expectedDiscount ? i.amount - c.principal - o.expectedDiscount : 0n;
      else if (!o) add["Buyer pays you"] = i.amount;
    } else if (scope.role === "buyer") add["You owe"] = i.amount;
    else if (scope.role === "financier") {
      if (!o || !c || o.financierId !== scope.businessId) continue;
      add["Principal back"] = c.principal; add["Your share of discount"] = financierShare(o.expectedDiscount);
    } else if (o && c) { add["Principal"] = c.principal; add["Discount"] = o.expectedDiscount; }
    else continue;
    const d = daysBetween(today, i.dueDate); // days from today to due
    for (const [k, v] of Object.entries(add)) {
      if (d < 0) out.overdue[k] += v;
      else { const w = Math.floor(d / 7); if (w < weeks) out.weeks[w].values[k] += v; }
    }
  }
  return out;
}

export const forecastCsv = (f: Forecast) => toCsv([
  ["week_starting", ...f.columns.map((c) => c.toLowerCase().replaceAll(/[^a-z]+/g, "_"))],
  ["overdue", ...f.columns.map((c) => toDecimal(f.overdue[c]))],
  ...f.weeks.map((w) => [w.start, ...f.columns.map((c) => toDecimal(w.values[c]))]),
]);
export const vintageCsv = (v: Awaited<ReturnType<typeof vintages>>) => toCsv([
  ["cohort", "invoices", "advanced", "repaid_principal", "outstanding", "late_30_plus", "written_off", "earned", "repaid_pct", "late_30_pct", "loss_pct"],
  ...v.map((e) => [e.month, e.invoices, toDecimal(e.advanced), toDecimal(e.repaid), toDecimal(e.outstanding), toDecimal(e.late30), toDecimal(e.lost), toDecimal(e.earned), e.repaidPct, e.late30Pct, e.lossPct]),
]);
export const concentrationCsv = (c: Awaited<ReturnType<typeof concentration>>) => toCsv([
  ["dimension", "name", "exposure", "share_pct"],
  ...c.byBuyer.top.map((x) => ["buyer", x.name, toDecimal(x.exposure), x.share]), ...c.bySeller.top.map((x) => ["seller", x.name, toDecimal(x.exposure), x.share]),
]);

// ---- scheduled reports ----
export const REPORTS = {
  forecast: { label: "Cash-flow forecast", build: async (db: Database, s: Scope, now: Date) => forecastCsv(await forecast(db, s, now)) },
  vintage: { label: "Vintage analysis", build: async (db: Database, s: Scope, now: Date) => vintageCsv(await vintages(db, s, now)) },
  concentration: { label: "Concentration", build: async (db: Database, s: Scope) => concentrationCsv(await concentration(db, s)) },
} as const;
export type ReportKind = keyof typeof REPORTS;
export const FREQUENCIES = { weekly: 7, monthly: 28 } as const; // monthly = every four weeks, so it never skips a month on a short one
type Frequency = keyof typeof FREQUENCIES;

export async function subscribe(db: Database, u: { id: string; role: string; businessId: string | null }, kind: string, frequency: string) {
  if (!(kind in REPORTS)) throw new Error("unknown report");
  if (!(frequency in FREQUENCIES)) throw new Error("choose weekly or monthly");
  await db.insert(reportSchedules).values({ userId: u.id, businessId: u.businessId, role: u.role, kind, frequency })
    .onConflictDoUpdate({ target: [reportSchedules.userId, reportSchedules.kind], set: { frequency, active: true } });
}
export async function unsubscribe(db: Database, userId: string, kind: string) {
  await db.update(reportSchedules).set({ active: false }).where(and(eq(reportSchedules.userId, userId), eq(reportSchedules.kind, kind)));
}

/** Worker: build every report that is due. A failing report does not stop the others; the schedule just stays due and tries again. */
export async function runDueReports(db: Database, gw: Adapters = gateway, now = new Date()) {
  const due = await db.select().from(reportSchedules).where(eq(reportSchedules.active, true));
  let made = 0;
  for (const s of due) {
    if (s.lastRunAt && now.getTime() - s.lastRunAt.getTime() < FREQUENCIES[s.frequency as Frequency] * 86_400_000 - 3_600_000) continue;
    try {
      const content = await REPORTS[s.kind as ReportKind].build(db, { role: s.role, businessId: s.businessId }, now);
      const [run] = await db.insert(reportRuns).values({ scheduleId: s.id, userId: s.userId, kind: s.kind, filename: `${s.kind}-${isoDay(now)}.csv`, content }).returning();
      await db.update(reportSchedules).set({ lastRunAt: now }).where(eq(reportSchedules.id, s.id));
      void run;
      await notifyUser(db, s.userId, "report_ready", { report: REPORTS[s.kind as ReportKind].label, link: s.businessId ? "/analytics" : "/admin/analytics" }, gw, now);
      made++;
    } catch (e) { console.error("[reports]", s.id, (e as Error).message); }
  }
  return made;
}
