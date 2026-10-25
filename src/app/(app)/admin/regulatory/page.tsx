import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { parReport, REPORTS, type Kind } from "@/server/regulatory/reports";
import { DataTable, Notice, PageHead, Panel } from "@/components/ui/page";
import { Downloads } from "@/components/ui/downloads";
import { market } from "@/lib/countries";

export const metadata = { title: "Regulatory drafts" };
const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function Regulatory({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const u = await requireUser(["ops", "admin", "compliance"]);
  const q = await searchParams;
  const now = new Date();
  const from = q.from ?? day(new Date(now.getTime() - 90 * 86_400_000)), to = q.to ?? day(now);
  const may = u.role !== "ops"; // downloads carry tax and registration numbers
  const par = await parReport(db, now);
  const hrefOf = (k: Kind) => (k === "str" ? `/api/admin/regulatory/str?from=${from}&to=${to}` : `/api/admin/regulatory/${k}`);
  return (
    <>
      <PageHead title="Regulatory drafts" sub={`Returns prepared from the books for ${market().regulator} and others. Each is a draft for the compliance officer to check and file; nothing is sent from here.`} />
      <div className="mb-4"><Notice tone="warn">The layout is the usual one for each return, not a regulator&apos;s own form. Confirm the form, and any extra columns, with counsel before filing.</Notice></div>
      {!may && <div className="mb-4"><Notice>Downloads are for admin and compliance, because the files carry tax and registration numbers. Every download is logged.</Notice></div>}
      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        {(Object.keys(REPORTS) as Kind[]).map((k) => (
          <Panel key={k} title={REPORTS[k].label} sub={REPORTS[k].blurb}>
            {k === "str" && (
              <form method="get" className="mb-3 flex flex-wrap items-end gap-2 text-sm">
                <label className="text-xs font-medium">From<input type="date" name="from" defaultValue={from} className="field-inline !py-1.5" /></label>
                <label className="text-xs font-medium">To<input type="date" name="to" defaultValue={to} className="field-inline !py-1.5" /></label>
                <button className="btn btn-ghost btn-sm">Set period</button>
              </form>
            )}
            {may ? <Downloads href={hrefOf(k)} /> : <span className="text-xs text-muted">View only</span>}
          </Panel>
        ))}
      </div>
      <Panel title="Portfolio at risk now" sub="A quick look. The download has the same figures." flush>
        <DataTable rows={par.rows} rowKey={(r) => String(r[0])}
          cols={par.head.map((h, i) => ({ h, align: i === 0 ? undefined : ("right" as const), cell: (r: (string | number | bigint | null)[]) => <span className={i === 0 ? "" : "tabular-nums"}>{String(r[i] ?? "")}</span> }))} />
      </Panel>
    </>
  );
}
