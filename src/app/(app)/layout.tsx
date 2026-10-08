import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { notifications } from "@/server/db/schema";
import { getMe } from "@/server/me";
import { getSession } from "@/server/session";
import { roleOf } from "@/server/permissions";
import { navBadges } from "@/server/reports/badges";
import { effectivePicks, enabledApps } from "@/lib/apps";
import { AppShell } from "@/components/shell/app-shell";
import { PendingForms } from "@/components/shell/pending";

// Every signed-in page lives under this layout. Page-level requireUser() still enforces MFA, roles and company setup;
// this only decides what chrome to draw, so an unauthenticated visitor never sees the shell.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Start everything that only needs the user id at once: the cookie already tells us who this is, so the database
  // round trips overlap instead of queueing (each one costs ~85 ms to the hosted database).
  const session = await getSession();
  if (!session) redirect("/login");
  const su = session.user as typeof session.user & { role: string; businessId: string | null };
  const [me, badges, inbox] = await Promise.all([
    getMe(), // authoritative role, suspension and company branding
    navBadges(db, { role: su.role, businessId: su.businessId }), // cosmetic counters: fine to use the cookie's view
    // The email copy of each message is the in-app inbox (SMS rows would just duplicate it).
    db.select().from(notifications).where(and(eq(notifications.userId, su.id), eq(notifications.channel, "email"))).orderBy(desc(notifications.createdAt)).limit(8),
  ]);
  if (!me) redirect("/login");
  if (me.suspendedAt) redirect("/account-suspended");

  const biz = me.biz && me.businessId ? me.biz : null;
  const company = biz ? { name: biz.displayName ?? biz.legalName, kyb: biz.kybStatus, logoUrl: biz.logoRef ? `/api/company/logo?v=${biz.logoRef.slice(0, 12)}` : null } : null;
  return (
    <AppShell
      user={{ name: me.name, email: me.email, role: me.role, orgRole: biz ? roleOf(me) : undefined }}
      business={company}
      apps={biz ? [...enabledApps(me.role, effectivePicks(biz, me.role))] : undefined}
      picked={biz?.apps}
      sandbox={(process.env.INTEGRATIONS_MODE ?? "mock") === "mock"}
      badges={badges}
      inbox={inbox.map((n) => ({ id: n.id, subject: n.subject ?? n.template.replaceAll("_", " "), body: n.body ?? "", at: n.createdAt.toISOString() }))}
      tourSeen={Boolean(me.tourSeenAt)}
    >
      <PendingForms />
      {children}
    </AppShell>
  );
}
