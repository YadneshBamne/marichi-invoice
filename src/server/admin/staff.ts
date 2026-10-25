// Platform staff join by emailed link, the same way company users do: the administrator chooses an email and a role, the new person
// sets their own password and second factor, and nobody else ever knows a credential. The first administrator is still created with
// scripts/seed-staff.ts, because someone has to exist before anyone can invite.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, invitations, users } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { appUrl } from "../notify";
import { render } from "../notify/templates";
import { STAFF_ROLES, type StaffRole } from "../support/policy";
import { INVITE_DAYS } from "../company/invitations";
import type { Admin } from "./service";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const staffInvite = (id: string) => and(eq(invitations.id, id), isNull(invitations.businessId));

async function send(db: Database, gw: Adapters, p: { to: string; role: StaffRole; inviterId: string; token: string }) {
  const link = `${appUrl()}/invite/${p.token}`;
  if (process.env.NODE_ENV !== "production") console.log(`[dev] staff invitation link for ${p.to}: ${link}`); // never shown in the product
  const [me] = await db.select({ n: users.name }).from(users).where(eq(users.id, p.inviterId));
  const r = render("staff_invite", "email", { role: p.role, inviter: me?.n ?? "An administrator", link, days: String(INVITE_DAYS) });
  try {
    await gw.notify.send({ channel: "email", to: p.to, template: "staff_invite", data: { link }, subject: r && "subject" in r ? r.subject : "You have been invited to the Marichi Labs team", body: r?.body ?? link });
    return true;
  } catch { return false; } // the administrator can press Resend
}

export async function inviteStaff(db: Database, actor: Admin, p: { email: string; role: StaffRole }, gw: Adapters = gateway, now = new Date()) {
  if (actor.role !== "admin") throw new Error("only an administrator can invite staff");
  if (!STAFF_ROLES.includes(p.role)) throw new Error("choose ops, compliance or admin");
  const to = p.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("enter a valid email address");
  const [person] = await db.select({ id: users.id }).from(users).where(eq(users.email, to));
  if (person) throw new Error("that email already has an account. Staff accounts are new accounts, so use a work address that is not yet on Marichi");
  await db.update(invitations).set({ status: "cancelled" }).where(and(isNull(invitations.businessId), eq(invitations.email, to), eq(invitations.status, "pending")));
  const token = newToken();
  const [inv] = await db.insert(invitations).values({
    businessId: null, email: to, orgRole: "viewer", staffRole: p.role, tokenHash: sha(token), invitedBy: actor.id,
    expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
  }).returning();
  await db.insert(auditLog).values({ actorId: actor.id, action: "staff.invited", entity: "user", entityId: inv.id, after: { email: to, role: p.role } });
  const emailed = await send(db, gw, { to, role: p.role, inviterId: actor.id, token });
  return { invitation: { id: inv.id, email: to, role: p.role }, emailed };
}

export async function listStaffInvitations(db: Database, now = new Date()) {
  const rows = await db.select().from(invitations).where(and(isNull(invitations.businessId), eq(invitations.status, "pending"))).orderBy(asc(invitations.createdAt));
  return rows.map((r) => ({ id: r.id, email: r.email, role: r.staffRole as StaffRole, expiresAt: r.expiresAt, expired: r.expiresAt <= now }));
}

export async function cancelStaffInvitation(db: Database, actor: Admin, id: string) {
  if (actor.role !== "admin") throw new Error("only an administrator can cancel an invitation");
  const [inv] = await db.select().from(invitations).where(and(staffInvite(id), eq(invitations.status, "pending")));
  if (!inv) throw new Error("that invitation is no longer open");
  await db.update(invitations).set({ status: "cancelled" }).where(eq(invitations.id, id));
  await db.insert(auditLog).values({ actorId: actor.id, action: "staff.invite_cancelled", entity: "user", entityId: id, after: { email: inv.email } });
}

/** A fresh link and a fresh ten days. The old link stops working. */
export async function resendStaffInvitation(db: Database, actor: Admin, id: string, gw: Adapters = gateway, now = new Date()) {
  if (actor.role !== "admin") throw new Error("only an administrator can resend an invitation");
  const [inv] = await db.select().from(invitations).where(and(staffInvite(id), eq(invitations.status, "pending")));
  if (!inv) throw new Error("that invitation is no longer open");
  const token = newToken();
  await db.update(invitations).set({ tokenHash: sha(token), expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000) }).where(eq(invitations.id, id));
  const emailed = await send(db, gw, { to: inv.email, role: inv.staffRole as StaffRole, inviterId: actor.id, token });
  await db.insert(auditLog).values({ actorId: actor.id, action: "staff.invite_resent", entity: "user", entityId: id, after: { email: inv.email } });
  return { emailed };
}
