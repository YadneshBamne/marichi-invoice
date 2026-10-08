import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { reportRuns, reportSchedules } from "@/server/db/schema";
import { concentration, forecast, REPORTS, vintages, type ReportKind, type Scope } from "@/server/analytics/service";
import { DataTable, PageHead, Panel } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { Bars } from "@/components/ui/charts";
import { formatCompactINR, formatINR } from "@/lib/money";
import { schedule } from "./actions";

const COPY: Record<string, { title: string; sub: string }> = {
  seller: { title: "Analytics", sub: "When your buyers will pay, how your financed invoices are performing, and which buyers you depend on." },
  buyer: { title: "Analytics", sub: "What you owe week by week and which suppliers carry the most of it." },
  financier: { title: "Analytics", sub: "Returns coming back, how each month's funding is performing, and how concentrated your book is." },
  staff: { title: "Analytics", sub: "The whole book: collections due, vintages, delinquency and concentration." },
};

/** One analytics page for every role; the data is already scoped to the person by `scope`. */
export async function Analytics({ scope, userId, path }: { scope: Scope; userId: string; path: "/analytics" | "/admin/analytics" }) {
  const staff = scope.businessId === null;
  const [fc, vin, con, scheds, runs] = await Promise.all([
    forecast(db, scope), vintages(db, scope), concentration(db, scope),
    db.select().from(reportSchedules).where(eq(reportSchedules.userId, userId)),
    db.select().from(reportRuns).where(eq(reportRuns.userId, userId)).orderBy(desc(reportRuns.createdAt)).limit(10),
  ]);
  const weekTotal = (v: Record<string, bigint>) => Object.values(v).reduce((a, b) => a + b, 0n);
  const overdue = weekTotal(fc.overdue);
  const next30 = fc.weeks.slice(0, 5).reduce((a, w) => a + weekTotal(w.values), 0n);
  const copy = COPY[staff ? "staff" : scope.role] ?? COPY.seller;
  const subscribed = new Map(scheds.filter((s) => s.active).map((s) => [s.kind, s.frequency]));

  return (
    <>
      <PageHead title={copy.title} sub={copy.sub} />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Next 5 weeks" value={formatINR(next30)} note={fc.columns.join(" and ").toLowerCase()} />
        <Stat label="Already past due" value={formatINR(overdue)} tone={overdue > 0n ? "bad" : "good"} note={overdue > 0n ? "due before today" : "nothing overdue"} />
        <Stat label="Open book" value={formatINR(con.total)} note="advanced and not yet repaid" />
        <Stat label="Buyer concentration" value={`${con.byBuyer.hhi.toLocaleString("en-IN")}`} note={con.byBuyer.hhi > 2500 ? "highly concentrated" : con.byBuyer.count ? "spread out" : "no open advances"} tone={con.byBuyer.hhi > 2500 ? "warn" : undefined} />
      </div>

      <Panel title="Cash-flow forecast" sub="Expected by due date, week by week from today" className="mb-5"
        action={<a className="btn btn-ghost btn-sm" href="/api/analytics/forecast">Download CSV</a>}>
        <Bars data={fc.weeks.map((w, i) => ({ label: i === 0 ? "This wk" : `+${i}w`, value: Number(weekTotal(w.values) / 100n) }))} format={(n) => formatCompactINR(BigInt(n) * 100n)} />
      </Panel>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <Panel title="Vintages" sub="Each month's funding, followed over time" flush action={<a className="btn btn-ghost btn-sm" href="/api/analytics/vintage">Download CSV</a>}>
          <DataTable rows={vin} rowKey={(v) => v.month} empty="Nothing funded yet."
            cols={[
              { h: "Funded in", cell: (v) => v.month },
              { h: "Invoices", align: "right", cell: (v) => v.invoices },
              { h: "Advanced", align: "right", cell: (v) => formatCompactINR(v.advanced) },
              { h: "Repaid", align: "right", cell: (v) => `${v.repaidPct}%` },
              { h: "30+ days late", align: "right", cell: (v) => <span className={v.late30Pct > 0 ? "text-r-600" : ""}>{v.late30Pct}%</span> },
              { h: "Lost", align: "right", cell: (v) => `${v.lossPct}%` },
            ]} />
        </Panel>
        <Panel title="Concentration" sub={`Share of the open book by ${staff ? "buyer and seller" : "buyer"}`} flush action={<a className="btn btn-ghost btn-sm" href="/api/analytics/concentration">Download CSV</a>}>
          <DataTable rows={[...con.byBuyer.top.map((x) => ({ ...x, side: "Buyer" })), ...(staff ? con.bySeller.top.map((x) => ({ ...x, side: "Seller" })) : [])]} rowKey={(x) => x.side + x.name} empty="No open advances."
            cols={[
              { h: "", cell: (x) => <span className="text-xs font-normal text-faint">{x.side}</span> },
              { h: "Name", cell: (x) => x.name },
              { h: "Exposure", align: "right", cell: (x) => formatCompactINR(x.exposure) },
              { h: "Share", align: "right", cell: (x) => `${x.share}%` },
            ]} />
        </Panel>
      </div>

      <Panel title="Scheduled reports" sub="Have a report built for you on a schedule. We email you when it is ready; it stays here to download.">
        <div className="grid gap-5 lg:grid-cols-2">
          <ul className="space-y-3 text-sm">
            {(Object.keys(REPORTS) as ReportKind[]).map((k) => (
              <li key={k} className="flex flex-wrap items-center justify-between gap-2">
                <span><b>{REPORTS[k].label}</b>{subscribed.has(k) && <span className="ml-2 text-xs text-muted">{subscribed.get(k)}</span>}</span>
                <form action={schedule} className="flex items-center gap-2">
                  <input type="hidden" name="kind" value={k} /><input type="hidden" name="path" value={path} />
                  <select name="frequency" defaultValue={subscribed.get(k) ?? "weekly"} className="field-inline !py-1 text-sm"><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
                  <button className="btn btn-ghost btn-sm">{subscribed.has(k) ? "Update" : "Schedule"}</button>
                  {subscribed.has(k) && <button name="action" value="stop" className="btn btn-ghost btn-sm">Stop</button>}
                </form>
              </li>
            ))}
          </ul>
          <div>
            <p className="mb-2 text-sm font-semibold">Recent reports</p>
            {runs.length === 0 ? <p className="text-sm text-muted">None yet. The first one is built the next morning.</p> : (
              <ul className="space-y-1.5 text-sm">{runs.map((r) => <li key={r.id} className="flex justify-between gap-3"><span className="text-muted">{r.createdAt.toLocaleDateString("en-IN")}</span><a className="font-semibold text-p-700 underline" href={`/api/analytics/run/${r.id}`}>{r.filename}</a></li>)}</ul>
            )}
          </div>
        </div>
      </Panel>
    </>
  );
}
