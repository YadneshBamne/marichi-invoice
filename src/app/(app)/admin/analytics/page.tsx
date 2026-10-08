import { requireUser } from "@/server/rbac";
import { Analytics } from "../../analytics/view";

export const metadata = { title: "Analytics" };

export default async function Page() {
  const u = await requireUser(["ops", "admin"]);
  return <Analytics scope={{ role: u.role, businessId: null }} userId={u.id} path="/admin/analytics" />;
}
