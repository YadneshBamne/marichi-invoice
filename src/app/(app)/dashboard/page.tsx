import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { buyerDashboard, sellerDashboard } from "@/server/reports/dashboards";
import { Card, Empty, PageHead } from "@/components/ui/cards";
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
    return (
      <>
        <PageHead title={`Hello, ${first}`} sub={`${company ? company + " · " : ""}The financier portal arrives in Phase 2.`} />
        <Card><Empty>Marketplace bidding, portfolio and yield reporting will appear here.</Empty></Card>
      </>
    );
  }
  return <SellerDashboardView d={await sellerDashboard(db, u.businessId!)} first={first} company={company} exports={exports} />;
}
