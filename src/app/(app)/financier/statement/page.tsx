import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { position, statement } from "@/server/marketplace/service";
import { DataTable, PageHead, Panel } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatMoney, toDecimal } from "@/lib/money";

export const metadata = { title: "Statement" };

export default async function Statement() {
  const u = await requireUser(["financier"]);
  const [rows, pos] = await Promise.all([statement(db, u.businessId!), position(db, u.businessId!)]);
  const csv = "date,description,reference,amount,balance\n" + rows.map((r) => [r.at.toISOString(), `"${r.label}"`, r.ref, toDecimal(r.delta), toDecimal(r.running)].join(",")).join("\n");
  return (
    <>
      <PageHead title="Statement" sub="Every movement on your funds, straight from the ledger. The balance is cash held for you in escrow.">
        <a className="btn btn-ghost btn-sm" download="marichi-statement.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}>Download CSV</a>
      </PageHead>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat hero label="Funds in escrow" value={formatMoney(pos.funds)} note="held for you" />
        <Stat label="Promised to deals" value={formatMoney(pos.reserved)} note="accepted, not yet paid out" />
        <Stat label="Available" value={formatMoney(pos.available)} note="free to bid or withdraw" tone="good" />
      </div>
      <p className="mb-4 text-sm text-muted">To add funds, transfer to the escrow account and tell us the reference; to withdraw, raise a request from Support. Our operations team records both.</p>
      <Panel flush>
        <DataTable rows={[...rows].reverse()} rowKey={(r) => r.ref + r.label} empty="No movements yet."
          cols={[
            { h: "Date", cell: (r) => r.at.toLocaleDateString("en-IN") },
            { h: "What", cell: (r) => r.label },
            { h: "Amount", align: "right", cell: (r) => <span className={r.delta < 0n ? "text-r-600" : "text-g-600"}>{r.delta < 0n ? "−" : "+"} {formatMoney(r.delta < 0n ? -r.delta : r.delta)}</span> },
            { h: "Balance", align: "right", cell: (r) => formatMoney(r.running) },
          ]} />
      </Panel>
    </>
  );
}
