import Link from "next/link";
import type { buyerDashboard, opsDashboard, sellerDashboard } from "@/server/reports/dashboards";
import { Card, Empty, PageHead, Pill, Stat, type Tone } from "@/components/ui/cards";
import { Bars, Donut, HBars } from "@/components/ui/charts";
import { Icon } from "@/components/ui/icons";
import { formatCompactMoney, formatMoney } from "@/lib/money";
import { buyerSteps, sellerSteps } from "@/lib/next-steps";
import { NextSteps } from "./next-steps";

// Pure presentation: data in, JSX out. Pages fetch; /design/dashboards renders the same views with sample data.
export type SellerData = Awaited<ReturnType<typeof sellerDashboard>>;
export type BuyerData = Awaited<ReturnType<typeof buyerDashboard>>;
export type OpsData = Awaited<ReturnType<typeof opsDashboard>>;

const STAGE: Record<string, string> = {
  uploaded: "Uploaded", validated: "Validated", sent_for_confirmation: "Awaiting buyer", confirmed: "Confirmed", eligible: "Ready for offer",
  disputed: "Disputed", financed: "Financed", due: "Due", overdue: "Overdue", paid: "Paid", rejected: "Rejected", written_off: "Written off",
};
const ORDER = Object.keys(STAGE);
const dueTone = (dpd: number): Tone => (dpd > 5 ? "bad" : dpd > 0 ? "warn" : "good");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;


export function SellerDashboardView({ d, first, exports = true, company }: { d: SellerData; first: string; exports?: boolean; company?: string }) {
  const todo = [
    d.attention.offers && { href: "/seller/invoices", text: `${plural(d.attention.offers, "offer")} waiting for your answer`, tone: "warn" as Tone },
    d.attention.toSign && { href: "/seller/agreements", text: `${plural(d.attention.toSign, "document")} to sign`, tone: "warn" as Tone },
    d.overdue && { href: "/seller/invoices", text: `${plural(d.overdue, "invoice")} past due`, tone: "bad" as Tone },
    d.attention.disputes && { href: "/support", text: `${plural(d.attention.disputes, "open dispute")}`, tone: "info" as Tone },
    d.attention.tickets && { href: "/support", text: `${plural(d.attention.tickets, "open support request")}`, tone: "neutral" as Tone },
  ].filter(Boolean) as { href: string; text: string; tone: Tone }[];
  const stages = ORDER.filter((s) => d.pipeline[s]).map((s) => ({ label: STAGE[s], value: d.pipeline[s], tone: s === "overdue" || s === "disputed" ? "var(--color-r-600)" : undefined }));

  return (
    <>
      <PageHead title={`Hello, ${first}`} sub={`${company ? company + " · " : ""}Your financing at a glance.`}>
        <Link className="btn btn-primary" href="/seller/invoices">Upload invoice</Link>
        {exports && <a className="btn btn-ghost" href="/api/export/invoices">Export CSV</a>}
      </PageHead>
      <NextSteps steps={sellerSteps({ kyb: d.kyb, ...d.setup })} />
      {d.kyb !== "approved" ? <Empty>Your limit, balances and invoices appear here once your business is verified.</Empty> : <>
      <div data-tour="kpis" className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Available credit" value={formatCompactMoney(d.available)} note={`of ${formatCompactMoney(d.limit)} limit`} href="/seller/invoices" />
        <Stat label="Outstanding" value={formatCompactMoney(d.outstanding)} note={plural(d.upcoming.length, "open invoice")} href="/seller/invoices" />
        <Stat label="Financed to date" value={formatCompactMoney(d.financedToDate)} note="gross advances" />
        <Stat label="Fees & discount paid" value={formatCompactMoney(d.feesPaid)} note="processing + discount" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="Paid out, last 7 days" className="xl:col-span-2">
          <Bars
            data={d.funding7d.map((x) => ({ label: new Date(x.date).toLocaleDateString("en-IN", { weekday: "narrow", timeZone: "UTC" }), value: Number(x.amount / 100n) }))}
            format={(n) => formatCompactMoney(BigInt(n) * 100n)}
          />
        </Card>
        <Card title="Needs your attention" tour="todo">
          {todo.length ? (
            <ul className="space-y-2">
              {todo.map((t) => (
                <li key={t.text}>
                  <Link href={t.href} className="flex items-center justify-between gap-3 rounded-lg bg-panel px-4 py-3 text-sm font-medium hover:bg-p-100">
                    <span>{t.text}</span><Pill tone={t.tone}>Open</Pill>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <Empty>You&apos;re all caught up.</Empty>}
        </Card>
        <Card title="Invoice pipeline">{stages.length ? <HBars rows={stages} /> : <Empty>No invoices yet. Upload your first one to get an offer in minutes.</Empty>}</Card>
        <Card title="Repayment schedule" className="xl:col-span-2">
          {d.upcoming.length ? (
            <table className="tbl text-sm">
              <thead><tr><th>Invoice</th><th>Buyer</th><th>Due</th><th className="text-right">Amount</th><th /></tr></thead>
              <tbody>
                {d.upcoming.map((r) => (
                  <tr key={r.invoiceId}>
                    <td className="font-medium">{r.number}</td><td>{r.buyer}</td><td>{r.due}</td>
                    <td className="text-right">{formatMoney(r.amount)}</td>
                    <td className="text-right"><Pill tone={dueTone(r.dpd)}>{r.dpd > 0 ? `${r.dpd}d late` : "On track"}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>Nothing due. Financed invoices appear here with their due dates.</Empty>}
        </Card>
        <Card title="Recent payouts" className="xl:col-span-3">
          {d.recent.length ? (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {d.recent.map((r) => (
                <li key={r.number} className="rounded-lg bg-panel p-4">
                  <div className="text-xs text-muted">{r.number}</div>
                  <div className="text-lg font-semibold">{formatCompactMoney(r.amount)}</div>
                  <div className="text-xs text-faint">{r.at?.toLocaleDateString("en-IN")}</div>
                </li>
              ))}
            </ul>
          ) : <Empty>No payouts yet.</Empty>}
        </Card>
      </div>
      </>}
    </>
  );
}


export function BuyerDashboardView({ d, first, exports = true, company }: { d: BuyerData; first: string; exports?: boolean; company?: string }) {
  const row = "flex items-center justify-between gap-3 py-3 text-sm";
  return (
    <>
      <PageHead title={`Hello, ${first}`} sub={`${company ? company + " · " : ""}Invoices to confirm and payments coming due.`}>
        <Link className="btn btn-primary" href="/buyer/invoices">Review invoices</Link>
        {exports && <a className="btn btn-ghost" href="/api/export/invoices">Export CSV</a>}
      </PageHead>
      <NextSteps steps={buyerSteps({ kyb: d.kyb, confirmed: d.confirmed, autopay: d.autopay })} />
      <div data-tour="kpis" className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Awaiting your confirmation" value={String(d.pendingCount)} note={`${formatCompactMoney(d.pendingValue)} in total`} href="/buyer/invoices" />
        <Stat label="Due in 30 days" value={formatCompactMoney(d.due30Value)} note={plural(d.due30Count, "invoice")} href="/buyer/invoices" />
        <Stat label="Overdue" value={formatCompactMoney(d.overdueValue)} note={d.overdueCount ? plural(d.overdueCount, "invoice") : "None"} tone={d.overdueCount ? "bad" : "good"} />
        <Stat label="Suppliers" value={String(d.suppliers.length)} note="linked to you" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="To confirm" action={<Link className="text-sm font-semibold text-p-700" href="/buyer/invoices">See all</Link>}>
          {d.awaiting.length ? (
            <ul className="divide-y divide-hair">
              {d.awaiting.map((r) => (
                <li key={r.id} className={row}>
                  <span><b>{r.number}</b><span className="block text-muted">{r.seller}</span></span>
                  <span className="text-right"><b>{formatMoney(r.amount)}</b><span className="block text-muted">due {r.due}</span></span>
                </li>
              ))}
            </ul>
          ) : <Empty>Nothing waiting for you.</Empty>}
        </Card>
        <Card title="Upcoming payments">
          {d.upcoming.length ? (
            <ul className="divide-y divide-hair">
              {d.upcoming.map((r) => (
                <li key={r.id} className={row}>
                  <span><b>{r.number}</b><span className="block text-muted">{r.seller} · due {r.due}</span></span>
                  <span className="text-right"><b>{formatMoney(r.amount)}</b><span className="block"><Pill tone={dueTone(r.dpd)}>{r.dpd > 0 ? `${r.dpd}d late` : "Upcoming"}</Pill></span></span>
                </li>
              ))}
            </ul>
          ) : <Empty>No payments due.</Empty>}
        </Card>
        <Card title="Supplier participation" className="xl:col-span-2">
          {d.suppliers.length ? (
            <HBars
              rows={d.suppliers.map((s) => ({ label: s.seller, value: Number(s.volume / 100n), note: `${s.invoices} invoices · ${s.terms}-day terms` }))}
              format={(n) => formatCompactMoney(BigInt(n) * 100n)}
            />
          ) : <Empty>No suppliers have linked to you yet.</Empty>}
        </Card>
      </div>
    </>
  );
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "");
const hours = (h: number | null) => (h === null ? "n/a" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);


export function OpsDashboardView({ d }: { d: OpsData }) {
  const q = d.queues;
  const queues: { label: string; n: number; href: string; bad?: boolean }[] = [
    { label: "KYB reviews", n: q.kyb, href: "/admin/kyb" },
    { label: "Underwriting referrals", n: q.underwriting, href: "/admin/underwriting" },
    { label: "Payouts awaiting approval", n: q.approvals, href: "/admin/disbursements" },
    { label: "Failed payouts", n: q.failedPayouts, href: "/admin/disbursements", bad: true },
    { label: "Unmatched bank credits", n: q.unmatched, href: "/admin/collections", bad: true },
    { label: "Open fraud cases", n: d.fraud.open, href: "/admin/fraud", bad: d.fraud.high > 0 },
    { label: "Support tickets (SLA missed)", n: q.ticketsBreached, href: "/admin/support?view=breached", bad: true },
    { label: "Support tickets (open)", n: q.ticketsOpen, href: "/admin/support" },
  ];
  const f = d.funnel;
  const b = d.buckets;
  const cents = (p: bigint) => Number(p / 100n);

  return (
    <>
      <PageHead title="Operations overview" sub="Volume, book health and the work waiting for your team.">
        <a className="btn btn-ghost" href="/api/export/invoices">Export invoices</a>
        <Link className="btn btn-ghost" href="/admin/ledger">Ledger & revenue</Link>
      </PageHead>

      <div data-tour="kpis" className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Funded this month" value={formatCompactMoney(d.gtvMonth)} note={d.gtvChangePct === null ? "No prior month yet" : `${d.gtvChangePct >= 0 ? "+" : ""}${d.gtvChangePct}% vs last month`} />
        <Stat label="Active book" value={formatCompactMoney(d.book)} note={`${d.openInvoices} open invoices`} />
        <Stat label="30+ days past due" value={`${d.npaPct}%`} note="of book by value" tone={d.npaPct > 3 ? "bad" : "good"} />
        <Stat label="Capital deployed" value={`${d.utilizationPct}%`} note={`${formatCompactMoney(d.deployed)} of ${formatCompactMoney(d.capital)}`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="Funded per month" className="xl:col-span-2">
          <Bars data={d.months.map((m) => ({ label: m.label, value: cents(m.amount) }))} format={(n) => formatCompactMoney(BigInt(n) * 100n)} highlight={5} />
        </Card>
        <Card title="Work queues" tour="queues">
          <ul className="space-y-1.5">
            {queues.map((x) => (
              <li key={x.label}>
                <Link href={x.href} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm hover:bg-panel">
                  <span>{x.label}</span><Pill tone={(x.n === 0 ? "neutral" : x.bad ? "bad" : "warn") as Tone}>{x.n}</Pill>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Invoice funnel, last 30 days" className="xl:col-span-2">
          <HBars rows={[
            { label: "Uploaded", value: f.uploaded },
            { label: "Confirmed by buyer", value: f.confirmed, note: pct(f.confirmed, f.uploaded) },
            { label: "Offer made", value: f.offered, note: pct(f.offered, f.confirmed) },
            { label: "Offer accepted", value: f.accepted, note: pct(f.accepted, f.offered) },
            { label: "Funded", value: f.funded, note: pct(f.funded, f.accepted) },
          ]} />
        </Card>
        <Card title="Book by days past due">
          <Donut
            slices={[
              { label: "Current", value: cents(b["0"]) }, { label: "1–30 days", value: cents(b["1-30"]) }, { label: "31–60", value: cents(b["31-60"]), color: "var(--color-s-500)" },
              { label: "61–90", value: cents(b["61-90"]), color: "var(--color-r-600)" }, { label: "90+ (NPA)", value: cents(b["90+"]), color: "var(--color-ink)" },
            ]}
            center={formatCompactMoney(d.book)} sub="outstanding" format={(n) => formatCompactMoney(BigInt(n) * 100n)}
          />
        </Card>

        <Card title="Turnaround (median)">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Upload → buyer confirmation</dt><dd className="font-semibold">{hours(d.tatConfirmHours)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Confirmation → money out</dt><dd className="font-semibold">{hours(d.tatPayoutHours)}</dd></div>
            <p className="text-xs text-faint">Targets: decision under 4 h, disbursement under 24 h.</p>
          </dl>
        </Card>
        <Card title="Escrow & reconciliation">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Escrow balance</dt><dd className="font-semibold">{formatCompactMoney(d.escrow)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Last reconciliation</dt>
              <dd>{d.recon ? <Pill tone={d.recon.status === "tied" ? "good" : "bad"}>{d.recon.date} · {d.recon.status}</Pill> : <Pill>not run yet</Pill>}</dd></div>
          </dl>
        </Card>
        <Card title="Risk">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Open fraud cases</dt><dd className="font-semibold">{d.fraud.open}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">High severity</dt><dd className="font-semibold">{d.fraud.high}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Book 30+ DPD</dt><dd className="font-semibold">{d.npaPct}%</dd></div>
          </dl>
        </Card>
      </div>
    </>
  );
}
