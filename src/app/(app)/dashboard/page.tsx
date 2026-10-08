import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { buyerDashboard, sellerDashboard } from "@/server/reports/dashboards";
import { Card, Empty, PageHead, Stat } from "@/components/ui/cards";
import { dealFlow, earnings, portfolio, position } from "@/server/marketplace/service";
import { formatINR } from "@/lib/money";
import Link from "next/link";
import { BuyerDashboardView, SellerDashboardView } from "@/components/dashboards/views";

export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const u = await requireUser();
  if (["ops", "admin", "compliance"].includes(u.role)) redirect("/admin");
  const first = u.name.split(" ")[0];
  const company = u.biz?.displayName ?? u.biz?.legalName;
  const exports = u.apps.has("exports");
  if (u.role === "buyer") return <BuyerDashboardView d={await buyerDashboard(db, u.businessId!)} first={first} company={company} exports={exports} />;
  if (u.role === "financier") {
    const [pos, earn, deals, book] = await Promise.all([position(db, u.businessId!), earnings(db, u.businessId!), dealFlow(db, u.businessId!), portfolio(db, u.businessId!)]);
    const late = book.filter((r) => r.dpd > 0 && r.outstandingPrincipal > 0n).length;
    return (
      <>
        <PageHead title={`Hello, ${first}`} sub={`${company ? company + " · " : ""}Your funds, your deals and what they have earned.`} />
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-tour="kpis">
          <Stat hero label="Available to bid" value={formatINR(pos.available)} note={`${formatINR(pos.funds)} in escrow`} href="/financier/statement" />
          <Stat label="Deployed" value={formatINR(pos.deployed)} note={`${book.filter((r) => r.outstandingPrincipal > 0n).length} invoices outstanding`} href="/financier/portfolio" />
          <Stat label="Earned" value={formatINR(earn.earned)} note="beyond principal" tone="good" />
          <Stat label="Open deals" value={String(deals.length)} note={late ? `${late} of yours past due` : "waiting for a bid"} tone={late ? "bad" : undefined} href="/financier/deals" />
        </div>
        {pos.funds === 0n && pos.deployed === 0n ? (
          <Card title="Get started"><Empty>Add funds by transferring to the escrow account and telling our operations team the bank reference. Once recorded, your balance appears here and you can <Link className="font-semibold text-p-700 underline" href="/financier/deals">start bidding</Link>.</Empty></Card>
        ) : null}
      </>
    );
  }
  return <SellerDashboardView d={await sellerDashboard(db, u.businessId!)} first={first} company={company} exports={exports} />;
}
