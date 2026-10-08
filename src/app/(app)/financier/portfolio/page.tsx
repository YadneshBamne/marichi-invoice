import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { earnings, portfolio, position } from "@/server/marketplace/service";
import { DataTable, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatINR } from "@/lib/money";

export const metadata = { title: "Portfolio" };

export default async function Portfolio() {
  const u = await requireUser(["financier"]);
  const [rows, pos, earn] = await Promise.all([portfolio(db, u.businessId!), position(db, u.businessId!), earnings(db, u.businessId!)]);
  const late = rows.filter((r) => r.dpd > 0 && r.outstandingPrincipal > 0n);
  const lateAmount = late.reduce((a, r) => a + r.outstandingPrincipal, 0n);
  return (
    <>
      <PageHead title="Portfolio" sub="Invoices you have funded, what is still owed, and what has come back." />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Deployed" value={formatINR(pos.deployed)} note={`${rows.filter((r) => r.outstandingPrincipal > 0n).length} invoices outstanding`} />
        <Stat label="Returned so far" value={formatINR(earn.returned)} note="principal and your share of discount" />
        <Stat label="Earned" value={formatINR(earn.earned)} note="beyond principal" tone="good" />
        <Stat label="Past due" value={formatINR(lateAmount)} note={late.length ? `${late.length} invoice${late.length === 1 ? "" : "s"}` : "none"} tone={late.length ? "bad" : "good"} />
      </div>
      <Panel title="Funded invoices" flush>
        <DataTable rows={rows} rowKey={(r) => r.invoiceId} empty="Nothing funded yet. Accepted bids appear here once the advance is paid out."
          cols={[
            { h: "Invoice", cell: (r) => r.invoiceNumber },
            { h: "Buyer", cell: (r) => r.buyer },
            { h: "Advance", align: "right", cell: (r) => formatINR(r.advance) },
            { h: "Outstanding", align: "right", cell: (r) => formatINR(r.outstandingPrincipal) },
            { h: "Discount accrued", align: "right", cell: (r) => formatINR(r.accruedDiscount) },
            { h: "Due", cell: (r) => r.dueDate },
            { h: "Days late", align: "right", cell: (r) => (r.dpd > 0 && r.outstandingPrincipal > 0n ? r.dpd : "–") },
            { h: "Status", cell: (r) => <StatusPill status={r.status} /> },
          ]} />
      </Panel>
    </>
  );
}
