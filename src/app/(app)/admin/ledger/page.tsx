import { desc } from "drizzle-orm";
import { db } from "@/server/db/client";
import { reconciliationRuns } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { portfolioXirr, revenueReport, trialBalance } from "@/server/ledger/reports";
import { DataTable, KV, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { Downloads } from "@/components/ui/downloads";
import { formatCompactMoney, formatMoney } from "@/lib/money";
import { market } from "@/lib/countries";

export const metadata = { title: "Ledger" };

export default async function Ledger() {
  await requireUser(["ops", "admin"]);
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const [tb, rev, y, runs] = await Promise.all([
    trialBalance(db),
    revenueReport(db, from, to), // ponytail: current month only; add a date picker when finance asks
    portfolioXirr(db),
    db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.date)).limit(14),
  ]);

  return (
    <>
      <PageHead title="Ledger and reconciliation" sub="Every rupee is booked twice. The trial balance must balance, and the bank statement must tie out each day.">
        <Downloads href="/api/admin/ledger-export?type=trial-balance" label="Trial balance" />
        <Downloads href="/api/admin/ledger-export?type=general-ledger" label="General ledger" />
      </PageHead>

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Net revenue this month" value={formatCompactMoney(rev.netRevenue)} note="fees + discount + penal, less losses" />
        <Stat label="Discount income" value={formatCompactMoney(rev.discountIncome)} note="this month" />
        <Stat label="Realised yield (XIRR)" value={y.xirr === null ? "n/a" : `${(y.xirr * 100).toFixed(2)}%`} note="on repaid invoices" />
        <Stat label="Trial balance" value={tb.balanced ? "Balanced" : "Out of balance"} tone={tb.balanced ? "good" : "bad"} note={`${formatMoney(tb.totalDebit)} each side`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
        <Panel title="Trial balance" sub="All ledger accounts" flush>
          <DataTable rows={tb.rows} rowKey={(r) => r.code} empty="No postings yet."
            cols={[
              { h: "Account", cell: (r) => <span className="font-mono text-[13px]">{r.code}</span> },
              { h: "Debit", align: "right", cell: (r) => formatMoney(r.debit) },
              { h: "Credit", align: "right", cell: (r) => formatMoney(r.credit) },
            ]} />
          <div className="flex items-center justify-between border-t border-hair bg-panel px-6 py-3 text-sm font-semibold"><span>Total</span><span>{formatMoney(tb.totalDebit)} / {formatMoney(tb.totalCredit)}</span></div>
        </Panel>

        <div className="space-y-5">
          <Panel title="Revenue this month">
            <KV rows={[
              [`Processing fees (ex-${market().tax.name})`, formatMoney(rev.feeIncome)], ["Discount income", formatMoney(rev.discountIncome)], ["Penal charges", formatMoney(rev.penalIncome)],
              ["Credit losses", `− ${formatMoney(rev.creditLoss)}`], ["Net revenue", <b key="n">{formatMoney(rev.netRevenue)}</b>], [`${market().tax.name} collected (payable)`, formatMoney(rev.gstCollected)],
            ]} />
          </Panel>
          <Panel title="Daily reconciliation" sub="Last 14 runs" flush>
            <DataTable rows={runs} rowKey={(r) => r.date} empty="No runs yet."
              cols={[
                { h: "Date", cell: (r) => r.date },
                { h: "Status", cell: (r) => <StatusPill status={r.status} /> },
                { h: "Variance", align: "right", cell: (r) => formatMoney(r.variance) },
                { h: "Exceptions", align: "right", cell: (r) => (r.exceptions as unknown[]).length },
              ]} />
          </Panel>
        </div>
      </div>
    </>
  );
}
