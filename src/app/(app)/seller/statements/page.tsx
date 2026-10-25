import { requireUser } from "@/server/rbac";
import { can } from "@/server/permissions";
import { db } from "@/server/db/client";
import { listStatements } from "@/server/statements/service";
import { summaryFromJson, type Flag, type Summary } from "@/server/statements/analyse";
import { EmptyState, Notice, PageHead, Panel, DataTable, Field } from "@/components/ui/page";
import { formatMoney } from "@/lib/money";
import { upload } from "./actions";

export const metadata = { title: "Bank statements" };

const TONE: Record<Flag["severity"], string> = { high: "bg-r-100 text-r-600", medium: "bg-s-100 text-s-600", low: "bg-panel text-muted" };
const LABEL: Record<Flag["severity"], string> = { high: "Look closely", medium: "Check", low: "Note" };
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
const month = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

function Figures({ s }: { s: Summary }) {
  const rows: [string, string][] = [
    ["Period", `${s.periodFrom} to ${s.periodTo} (${s.months} month${s.months === 1 ? "" : "s"})`],
    ["Money in, average per month", formatMoney(s.avgMonthlyTurnover)],
    ["Money in / out, total", `${formatMoney(s.totalCredits)} / ${formatMoney(s.totalDebits)}`],
    ["Average balance", s.avgBalance === null ? "Not in the file" : formatMoney(s.avgBalance)],
    ["Lowest balance", s.minBalance === null ? "Not in the file" : formatMoney(s.minBalance)],
    ["Bounced payments", `${s.inwardReturns.count} from you, ${s.outwardReturns.count} to you`],
    ["Cash deposits", `${pct(s.cashShareBps)} of money in`],
    ["Biggest payer", s.topPayers.length ? `${pct(s.topPayerShareBps)} of money in` : "Not named in the file"],
  ];
  return <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-4 border-b border-hair py-1.5"><dt className="text-muted">{k}</dt><dd className="text-right font-medium">{v}</dd></div>)}</dl>;
}

export default async function Statements({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["seller"]);
  const q = await searchParams;
  const rows = await listStatements(db, u.businessId!);

  return (
    <div className="text-sm">
      <PageHead title="Bank statements" sub="Upload the statement of the account your customers pay into. We read it and work out the figures a financier looks at: money in, balances, bounced payments and who pays you." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}

      {can(u, "invoice.upload") && (
        <Panel title="Upload a statement" sub="A CSV from net banking, or a PDF downloaded from net banking (not a scan or a photo). Up to 4 MB. Six months or more works best." className="mb-5">
          <form action={upload} className="flex flex-wrap items-end gap-3">
            <Field label="Statement file" className="min-w-0 flex-1" hint="CSV or PDF">
              <input name="file" type="file" required accept=".csv,.pdf,text/csv,application/pdf" className="field font-normal !py-2 text-sm" />
            </Field>
            <button className="btn btn-primary">Upload and read</button>
          </form>
          <p className="mt-4 text-xs text-muted">
            What we check, and why: that the running balance adds up row by row, that dates run in order and no row is repeated, because a statement edited by hand rarely stays consistent.
            Then the figures: monthly money in and out, average and lowest balance, bounced cheques and auto-debits, the share of cash deposits, your biggest payers and payees, and any amount that came in and went straight out again.
            Nothing here approves or declines you. A person reads the figures with everything else.
          </p>
        </Panel>
      )}

      {rows.length === 0 ? (
        <EmptyState icon="file" title="No statement yet">Upload one above and the figures appear here.</EmptyState>
      ) : rows.map((r) => {
        const s = r.status === "parsed" && r.summary ? summaryFromJson(r.summary) : null;
        return (
          <Panel key={r.id} className="mb-5"
            title={`${r.bankName ?? "Bank statement"}${r.accountLast4 ? ` ending ${r.accountLast4}` : ""}`}
            sub={`${r.fileName} · uploaded ${r.createdAt.toLocaleDateString("en-IN")}`}
            action={<span className={`pill ${s ? "bg-g-100 text-g-600" : "bg-r-100 text-r-600"}`}>{s ? "Read" : "Could not read"}</span>}>
            {!s && <p className="text-r-600">{r.failure ?? "This file could not be read."}</p>}
            {s && (
              <div className="space-y-5">
                {s.flags.length > 0 ? (
                  <ul className="space-y-2">
                    {s.flags.map((f) => <li key={f.code} className="flex items-start gap-2"><span className={`pill shrink-0 ${TONE[f.severity]}`}>{LABEL[f.severity]}</span><span>{f.text}</span></li>)}
                  </ul>
                ) : <p className="text-g-600">Nothing unusual found in this statement.</p>}
                <Figures s={s} />
                <div className="-mx-5 sm:-mx-6">
                  <DataTable rows={s.byMonth} rowKey={(m) => m.month}
                    cols={[
                      { h: "Month", cell: (m) => month(m.month) },
                      { h: "Money in", align: "right", cell: (m) => formatMoney(m.credits) },
                      { h: "Money out", align: "right", cell: (m) => formatMoney(m.debits) },
                      { h: "Average balance", align: "right", cell: (m) => (m.avgBalance === null ? "-" : formatMoney(m.avgBalance)) },
                      { h: "Lowest balance", align: "right", cell: (m) => (m.minBalance === null ? "-" : formatMoney(m.minBalance)) },
                    ]} />
                </div>
                {(s.topPayers.length > 0 || s.topPayees.length > 0) && (
                  <div className="grid gap-5 md:grid-cols-2">
                    {([["Who pays you most", s.topPayers], ["Who you pay most", s.topPayees]] as const).map(([title, list]) => (
                      <div key={title}>
                        <p className="mb-1 font-semibold">{title}</p>
                        {list.length === 0 ? <p className="text-muted">Names could not be read from the narration.</p> : (
                          <ul className="space-y-1">{list.map((p) => <li key={p.name} className="flex justify-between gap-4"><span className="min-w-0 truncate">{p.name}</span><span className="shrink-0 text-muted">{formatMoney(p.total)} · {p.count}×</span></li>)}</ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
