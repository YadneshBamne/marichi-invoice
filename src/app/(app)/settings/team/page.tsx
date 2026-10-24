import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { businesses } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { listTeam, pendingOwnership } from "@/server/company/service";
import { listInvitations } from "@/server/company/invitations";
import { can } from "@/server/permissions";
import { TeamManager } from "./manager";

export const metadata = { title: "Team" };

export default async function Team() {
  const u = await requireUser(["seller", "buyer", "financier"]);
  if (!u.businessId) redirect("/settings/profile");
  const [rows, invites, transfer, [biz]] = await Promise.all([
    listTeam(db, u.businessId), listInvitations(db, u.businessId), pendingOwnership(db, u.businessId),
    db.select({ dual: businesses.dualControl }).from(businesses).where(eq(businesses.id, u.businessId)),
  ]);
  const people = rows.map((r) => ({ id: r.id, name: r.name, email: r.email, orgRole: r.orgRole, suspended: !!r.suspendedAt, twoFactor: !!r.twoFactor, you: r.id === u.id }));
  return (
    <TeamManager
      people={people}
      invites={invites.map((i) => ({ id: i.id, email: i.email, orgRole: i.orgRole, expired: i.expired, expiresAt: i.expiresAt.toISOString() }))}
      me={{ id: u.id, orgRole: u.orgRole }}
      manage={can(u, "team.manage")} grant={can(u, "team.grant")}
      dual={biz?.dual ?? false}
      transfer={transfer ? { toId: transfer.toUserId, toName: people.find((p) => p.id === transfer.toUserId)?.name ?? "someone", expiresAt: transfer.expiresAt.toISOString() } : null}
    />
  );
}
