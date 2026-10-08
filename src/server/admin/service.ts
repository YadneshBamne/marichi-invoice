// Admin hub (Module 15): staff role management, audit-log search, system health. Admin-only; every change is audited.
import { and, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, disbursements, externalCalls, notifications, users } from "../db/schema";
import { STAFF_ROLES, type StaffRole } from "../support/policy";

export type Admin = { id: string; role: string };

export const listUsers = (db: Database, q?: string) =>
  db.select({ id: users.id, name: users.name, email: users.email, role: users.role, mfa: users.twoFactorEnabled, kyc: users.kycStatus, createdAt: users.createdAt })
    .from(users).where(q ? ilike(users.email, `%${q}%`) : undefined).orderBy(desc(users.createdAt)).limit(100);

/** Change a STAFF member's role. Customers (seller/buyer/financier) never become staff here, and nobody edits their own role (no lockout). */
export async function setStaffRole(db: Database, actor: Admin, userId: string, role: StaffRole) {
  if (actor.role !== "admin") throw new Error("only an admin can change roles");
  if (!STAFF_ROLES.includes(role)) throw new Error("invalid staff role");
  if (userId === actor.id) throw new Error("you cannot change your own role");
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!u) throw new Error("user not found");
    if (!STAFF_ROLES.includes(u.role as StaffRole)) throw new Error("only staff roles can be changed here");
    if (u.role === role) return;
    await tx.update(users).set({ role }).where(eq(users.id, userId));
    await tx.insert(auditLog).values({ actorId: actor.id, action: "user.role_changed", entity: "user", entityId: userId, before: { role: u.role }, after: { role } });
  });
}

export const searchAudit = (db: Database, f: { entity?: string; action?: string; limit?: number }) =>
  db.select().from(auditLog)
    .where(and(f.entity ? eq(auditLog.entity, f.entity) : undefined, f.action ? ilike(auditLog.action, `%${f.action}%`) : undefined))
    .orderBy(desc(auditLog.createdAt)).limit(Math.min(f.limit ?? 100, 500));

export async function systemHealth(db: Database, now = new Date()) {
  const one = async (q: Promise<{ n: number }[]>) => (await q)[0].n;
  const stuckBefore = new Date(now.getTime() - 15 * 60_000);
  const [queued, failedNotifs, failedPayouts, awaitingApproval, calls24h] = await Promise.all([
    one(db.select({ n: count() }).from(notifications).where(eq(notifications.status, "queued"))),
    one(db.select({ n: count() }).from(notifications).where(eq(notifications.status, "failed"))),
    one(db.select({ n: count() }).from(disbursements).where(eq(disbursements.status, "failed"))),
    one(db.select({ n: count() }).from(disbursements).where(and(eq(disbursements.needsApproval, true), sql`${disbursements.approvedAt} is null`, inArray(disbursements.status, ["pending"])))),
    one(db.select({ n: count() }).from(externalCalls).where(sql`${externalCalls.createdAt} > ${new Date(now.getTime() - 86_400_000)}`)),
  ]);
  const stuckNotifs = await one(db.select({ n: count() }).from(notifications).where(and(eq(notifications.status, "sending"), sql`${notifications.claimedAt} < ${stuckBefore}`)));
  // Worker liveness = most recent finished pg-boss job. The schema only exists once the worker has run.
  let workerLastRun: Date | null = null;
  try {
    const r = await db.execute(sql`select max(completed_on) as t from pgboss.job`);
    const t = (r.rows as { t: Date | null }[])[0]?.t;
    workerLastRun = t ? new Date(t) : null;
  } catch { /* no pgboss schema */ }
  const mode = process.env.INTEGRATIONS_MODE ?? "mock";
  return { queued, failedNotifs, stuckNotifs, failedPayouts, awaitingApproval, calls24h, workerLastRun, integrationsMode: mode, reconGate: process.env.RECON_GATE === "on" };
}
