import { requireApp, requireUser } from "@/server/rbac";
import { Analytics } from "./view";

export const metadata = { title: "Analytics" };

export default async function Page() {
  const u = await requireUser(["seller", "buyer", "financier"]);
  requireApp(u, "analytics");
  return <Analytics scope={{ role: u.role, businessId: u.businessId! }} userId={u.id} path="/analytics" />;
}
