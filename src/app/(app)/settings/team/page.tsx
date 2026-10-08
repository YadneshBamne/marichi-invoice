import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { listTeam } from "@/server/company/service";
import { can } from "@/server/permissions";
import { TeamManager } from "./manager";

export const metadata = { title: "Team" };

export default async function Team() {
  const u = await requireUser(["seller", "buyer", "financier"]);
  if (!u.businessId) redirect("/settings/profile");
  const rows = await listTeam(db, u.businessId);
  return <TeamManager manage={can(u, "team.manage")} people={rows.map((r) => ({ id: r.id, name: r.name, email: r.email, orgRole: r.orgRole, suspended: !!r.suspendedAt, mustChange: r.mustChangePassword, you: r.id === u.id }))} />;
}
