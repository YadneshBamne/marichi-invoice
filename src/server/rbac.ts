import { redirect } from "next/navigation";
import { effectivePicks, enabledApps } from "../lib/apps";
import { db } from "./db/client";
import { refreshPolicy } from "./config/policy";
import { refreshFlags } from "./flags/service";
import { getMe } from "./me";
import { roleOf } from "./permissions";

type Role = "seller" | "buyer" | "financier" | "admin" | "ops" | "compliance";

/**
 * Server-side guard for pages/actions. Always call this; never trust the client.
 * Order matters: signed in -> not suspended -> password issued by the owner replaced -> MFA enrolled (PRD 7.1: mandatory
 * for every role) -> role allowed -> company owner has finished the setup wizard.
 */
export async function requireUser(roles?: Role[], opts?: { skipSetup?: boolean }) {
  const [me] = await Promise.all([getMe(), refreshPolicy(db), refreshFlags(db)]); // policy edits reach this instance within 30 s
  if (!me) redirect("/login");
  if (me.suspendedAt) redirect("/account-suspended");
  if (me.mustChangePassword) redirect("/change-password");
  if (!me.twoFactorEnabled) redirect("/mfa");
  if (roles && !roles.includes(me.role)) redirect("/forbidden");
  const orgRole = roleOf(me);
  if (!opts?.skipSetup && me.businessId && orgRole === "owner" && me.biz && !me.biz.setupCompletedAt) redirect("/setup");
  const apps = me.biz ? enabledApps(me.role, effectivePicks(me.biz, me.role)) : new Set<string>();
  return { ...me, role: me.role as Role, orgRole, apps };
}

/** Pages of an optional app: if the owner switched it off, send the user to the apps page instead of a dead screen. */
export function requireApp(u: { apps: Set<string>; orgRole: string }, id: string) {
  if (!u.apps.has(id)) redirect(u.orgRole === "owner" ? "/apps" : "/forbidden");
}
