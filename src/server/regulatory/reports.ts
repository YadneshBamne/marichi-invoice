// Draft returns for the regulator. Each is built from the books as they stand now, labelled DRAFT on every download, and is for the
// compliance officer to check and file; nothing here is ever sent anywhere. The shape of each return is the usual one, not a
// specific regulator's form: the form (and any column the regulator adds) is confirmed with counsel per country (docs/PLATFORM-GUIDE.md).
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, disbursements, financingOffers, fraudCases, invoiceCollections, invoices, strReports } from "../db/schema";
import { accrue, daysBetween, isoDay, type Bucket, bucketOf } from "../collections/waterfall";
import { ACCOUNTS, balance } from "../ledger/accounts";
import type { Table } from "../exports/table";
import { market } from "../../lib/countries";
import { toDecimal } from "../../lib/money";

export type Staff = { id: string; role: string };
const ALLOWED = ["admin", "compliance"];
const DAY = 86_400_000;

export const REPORTS = {
  par: { label: "Portfolio at risk", blurb: "Open financed invoices by days past due, with the share of the book that is late." },
  bureau: { label: "Credit information file", blurb: "One line per financing facility: amount, what is outstanding and overdue, days past due, and the status, for the credit bureaus." },
  str: { label: "Suspicious transaction reports", blurb: "Reports drafted from confirmed fraud and sanctions cases in a period, with their filing status." },
  capital: { label: "Capital adequacy inputs", blurb: "The figures the finance team needs for the capital return, taken from the ledger and the open book." },
} as const;
export type Kind = keyof typeof REPORTS;
export const isKind = (k: string): k is Kind => k in REPORTS;

const banner = (now: Date) => `DRAFT for the compliance officer to review. Not filed with ${market().regulator}. Figures as at ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
const pct = (n: bigint, d: bigint) => (d > 0n ? Number((n * 10_000n) / d) / 100 : 0);
const BUCKET_LABEL: Record<Bucket, string> = { "0": "Not yet due", "1-30": "1 to 30 days", "31-60": "31 to 60 days", "61-90": "61 to 90 days", "90+": "Over 90 days (non-performing)" };

/** Every open financed invoice with what is owing today and how late it is. */
async function openBook(db: Database, now: Date) {
  const today = isoDay(now);
  const rows = await db.select({ i: invoices, c: invoiceCollections }).from(invoiceCollections).innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).where(isNull(invoiceCollections.closedAt));
  return rows.map(({ i, c }) => {
    const s = accrue({ principal: c.principal, discount: c.discount, penal: c.penal, lastAccrued: c.lastAccruedOn }, today, { discountBps: c.discountBps, penalBps: c.penalBps, dueDate: i.dueDate });
    return { invoice: i, principal: s.principal, outstanding: s.principal + s.discount + s.penal, dpd: Math.max(0, daysBetween(i.dueDate, today)) };
  });
}

export async function parReport(db: Database, now: Date): Promise<Table> {
  const book = await openBook(db, now);
  const by = new Map<Bucket, { n: number; principal: bigint; total: bigint }>((Object.keys(BUCKET_LABEL) as Bucket[]).map((b) => [b, { n: 0, principal: 0n, total: 0n }]));
  for (const x of book) { const e = by.get(bucketOf(x.dpd))!; e.n++; e.principal += x.principal; e.total += x.outstanding; }
  const principal = book.reduce((a, x) => a + x.principal, 0n);
  const over = (min: number) => book.filter((x) => x.dpd > min).reduce((a, x) => a + x.principal, 0n);
  const lost = (await db.select({ p: sql<string>`coalesce(sum((after->>'principal')::bigint), 0)::text` }).from(auditLog).where(eq(auditLog.action, "invoice.write_off")))[0].p;
  return {
    title: "Portfolio at risk", note: banner(now),
    head: ["Days past due", "Invoices", "Principal outstanding", "Total outstanding", "Share of principal %"],
    rows: [
      ...[...by.entries()].map(([b, e]) => [BUCKET_LABEL[b], e.n, toDecimal(e.principal), toDecimal(e.total), pct(e.principal, principal)]),
      ["Total open book", book.length, toDecimal(principal), toDecimal(book.reduce((a, x) => a + x.outstanding, 0n)), 100],
      ["Portfolio at risk, over 30 days", "", toDecimal(over(30)), "", pct(over(30), principal)],
      ["Portfolio at risk, over 90 days", "", toDecimal(over(90)), "", pct(over(90), principal)],
      ["Written off to date (principal)", "", toDecimal(BigInt(lost)), "", ""],
    ],
  };
}

const classOf = (status: string, closed: boolean, dpd: number) =>
  status === "written_off" ? "Written off" : closed ? "Closed" : dpd <= 0 ? "Standard" : dpd <= 30 ? "Overdue 1-30" : dpd <= 60 ? "Overdue 31-60" : dpd <= 90 ? "Overdue 61-90" : "Overdue over 90 (non-performing)";

export async function bureauFile(db: Database, now: Date): Promise<Table> {
  const today = isoDay(now), cutoff = new Date(now.getTime() - 365 * DAY);
  const rows = await db.select({ i: invoices, o: financingOffers, d: disbursements, c: invoiceCollections }).from(disbursements)
    .innerJoin(financingOffers, eq(financingOffers.id, disbursements.offerId)).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .leftJoin(invoiceCollections, eq(invoiceCollections.invoiceId, invoices.id))
    .where(and(eq(disbursements.status, "succeeded"), sql`(${invoiceCollections.closedAt} is null or ${invoiceCollections.closedAt} >= ${cutoff.toISOString()})`))
    .orderBy(asc(disbursements.completedAt));
  const ids = [...new Set(rows.flatMap((r) => [r.i.sellerId, r.i.buyerId]))];
  const biz = new Map((ids.length ? await db.select().from(businesses).where(inArray(businesses.id, ids)) : []).map((b) => [b.id, b]));
  const out = rows.map(({ i, o, d, c }) => {
    const s = c && !c.closedAt ? accrue({ principal: c.principal, discount: c.discount, penal: c.penal, lastAccrued: c.lastAccruedOn }, today, { discountBps: c.discountBps, penalBps: c.penalBps, dueDate: i.dueDate }) : null;
    const owed = s ? s.principal + s.discount + s.penal : 0n, dpd = s ? Math.max(0, daysBetween(i.dueDate, today)) : 0;
    const b = biz.get(i.sellerId);
    return [
      i.invoiceNumber, b?.legalName ?? "", b?.pan ?? "", b?.gstin ?? b?.cin ?? "", biz.get(i.buyerId)?.legalName ?? "",
      isoDay(d.completedAt ?? d.createdAt), toDecimal(o.advanceAmount), toDecimal(owed), toDecimal(dpd > 0 ? owed : 0n), dpd, i.dueDate,
      classOf(i.status, !s, dpd), c?.closedAt ? isoDay(c.closedAt) : "",
    ];
  });
  return {
    title: "Credit information file", note: `${banner(now)} For ${market().returns.bureau}. Open facilities and those closed in the last 12 months.`,
    head: ["Facility reference", "Borrower", `Borrower ${market().ids.kyb.label}`, "Borrower registration", "Buyer", "Disbursed on", "Amount advanced", "Outstanding", "Overdue", "Days past due", "Due date", "Status", "Closed on"],
    rows: out,
  };
}

export async function strDrafts(db: Database, now: Date, from: string, to: string): Promise<Table> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error("choose a period: a start date on or before the end date");
  const rows = await db.select({ s: strReports, c: fraudCases }).from(strReports).innerJoin(fraudCases, eq(fraudCases.id, strReports.caseId))
    .where(and(gte(strReports.createdAt, new Date(`${from}T00:00:00Z`)), lt(strReports.createdAt, new Date(Date.parse(`${to}T00:00:00Z`) + DAY)))).orderBy(asc(strReports.createdAt));
  const invIds = rows.filter((r) => r.c.entityType === "invoice").map((r) => r.c.entityId);
  const invs = new Map((invIds.length ? await db.select().from(invoices).where(inArray(invoices.id, invIds)) : []).map((i) => [i.id, i]));
  const subjectId = (c: typeof fraudCases.$inferSelect) => c.subjectBusinessId ?? (c.entityType === "business" ? c.entityId : invs.get(c.entityId)?.sellerId ?? null);
  const bizIds = [...new Set(rows.map((r) => subjectId(r.c)).filter((x): x is string => !!x))];
  const biz = new Map((bizIds.length ? await db.select().from(businesses).where(inArray(businesses.id, bizIds)) : []).map((b) => [b.id, b]));
  return {
    title: `Suspicious transaction reports ${from} to ${to}`, note: `${banner(now)} For ${market().returns.fiu}. Filing is recorded on the case; this is the content only.`,
    head: ["Reference", "Raised on", "Filing status", "Filed on", "Regulator reference", "Subject", `Subject ${market().ids.kyb.label}`, "Subject registration", "Grounds", "Severity", "Case outcome", "Invoice", "Amount involved", "Narrative"],
    rows: rows.map(({ s, c }) => {
      const b = biz.get(subjectId(c) ?? ""), inv = invs.get(c.entityId);
      return [`STR-${s.caseId.slice(0, 8).toUpperCase()}`, isoDay(s.createdAt), s.status, s.filedAt ? isoDay(s.filedAt) : "", s.reference ?? "", b?.legalName ?? "", b?.pan ?? "", b?.gstin ?? b?.cin ?? "", c.ruleTriggered, c.severity, c.outcome ?? "", inv?.invoiceNumber ?? "", inv ? toDecimal(inv.amount) : "", s.narrative];
    }),
  };
}

/** The inputs only: the capital return itself is worked out by finance from audited figures and the regulator's risk weights. */
export async function capitalInputs(db: Database, now: Date): Promise<Table> {
  const book = await openBook(db, now);
  const ownIds = new Set((await db.select({ id: financingOffers.invoiceId }).from(financingOffers).where(and(eq(financingOffers.status, "accepted"), isNull(financingOffers.financierId)))).map((r) => r.id));
  const own = book.filter((x) => ownIds.has(x.invoice.id)); // funded from the platform's own balance sheet; financier-funded deals are not the platform's risk
  const exposure = own.reduce((a, x) => a + x.principal, 0n);
  const capital = -(await balance(db, ACCOUNTS.capital)); // a credit balance is negative in the ledger
  const byBuyer = new Map<string, bigint>();
  for (const x of own) byBuyer.set(x.invoice.buyerId, (byBuyer.get(x.invoice.buyerId) ?? 0n) + x.principal);
  const [top] = [...byBuyer.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const topName = top ? (await db.select({ n: businesses.legalName }).from(businesses).where(eq(businesses.id, top[0])))[0]?.n ?? "" : "";
  const row = (k: string, v: string | number, note = ""): (string | number)[] => [k, v, note];
  return {
    title: "Capital adequacy inputs", note: `${banner(now)} Inputs for ${market().returns.capitalRule}; finance works out the ratio.`,
    head: ["Item", "Value", "Note"],
    rows: [
      row("Platform capital in the ledger", toDecimal(capital), "Account platform_capital"),
      row("Open principal funded from the platform's own balance sheet", toDecimal(exposure), `${own.length} invoice${own.length === 1 ? "" : "s"}`),
      row("Of which more than 90 days past due", toDecimal(own.filter((x) => x.dpd > 90).reduce((a, x) => a + x.principal, 0n)), "Non-performing"),
      row("Risk weight applied in this draft, %", 100, "Placeholder. The regulator's weights by buyer rating go here."),
      row("Risk-weighted exposure", toDecimal(exposure), "Exposure x weight"),
      row("Capital as a share of risk-weighted exposure, %", exposure > 0n ? pct(capital, exposure) : "", "For a quick look only"),
      row("Largest single-buyer exposure", top ? toDecimal(top[1]) : "0.00", topName),
      row("Largest single-buyer exposure as a share of capital, %", top && capital > 0n ? pct(top[1], capital) : "", "Concentration"),
      row("Open principal funded by financiers (not the platform's risk)", toDecimal(book.reduce((a, x) => a + x.principal, 0n) - exposure), "For context"),
    ],
  };
}

/** Build a draft and record who took it, because these files carry personal and tax identifiers. */
export async function buildReport(db: Database, staff: Staff, kind: Kind, p: { from?: string; to?: string } = {}, now = new Date()): Promise<Table> {
  if (!ALLOWED.includes(staff.role)) throw new Error("forbidden");
  const t = kind === "par" ? await parReport(db, now) : kind === "bureau" ? await bureauFile(db, now)
    : kind === "capital" ? await capitalInputs(db, now) : await strDrafts(db, now, p.from ?? isoDay(new Date(now.getTime() - 90 * DAY)), p.to ?? isoDay(now));
  await db.insert(auditLog).values({ actorId: staff.id, action: "regulatory.draft", entity: "report", entityId: kind, after: { rows: t.rows.length, ...(kind === "str" ? { from: p.from, to: p.to } : {}) } });
  return t;
}
