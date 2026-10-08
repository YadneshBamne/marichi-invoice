import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { opsDashboard } from "@/server/reports/dashboards";
import { OpsDashboardView } from "@/components/dashboards/views";

export const metadata = { title: "Operations overview" };

export default async function Overview() {
  await requireUser(["ops", "admin", "compliance"]);
  return <OpsDashboardView d={await opsDashboard(db)} />;
}
