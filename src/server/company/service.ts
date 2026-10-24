// Company workspace: profile, apps, and the people inside it. People join by invitation (see invitations.ts); here we run the
// team afterwards: roles, suspension, ownership transfer, and switching between companies.
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, memberships, ownershipTransfers, session, users, type OrgRole } from "../db/schema";
import { cleanSelection } from "../../lib/apps";
import { assertCan, INVITABLE, POWERFUL, roleOf } from "../permissions";
import { putLogo } from "../vault";

export type Actor = { id: string; role: string; orgRole: string; businessId: string | null };

const need = (a: Actor) => { if (!a.businessId) throw new Error("no company linked to this account"); return a.businessId; };
const TRANSFER_DAYS = 7;

/** Everyone in the company, with the role they hold HERE (a person can hold a different role in another company). */
export const listTeam = (db: Database, businessId: string) =>
  db.select({
    id: users.id, name: users.name, email: users.email, orgRole: memberships.orgRole,
    suspendedAt: memberships.suspendedAt, joinedAt: memberships.createdAt, twoFactor: users.twoFactorEnabled,
  }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.businessId, businessId)).orderBy(asc(memberships.createdAt));

/** The target must belong to the actor's company, not be the actor, and not be the owner. */
async function target(db: Database, a: Actor, userId: string) {
  const businessId = need(a);
  if (userId === a.id) throw new Error("you cannot change your own access here");
  const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.businessId, businessId)));
  if (!m) throw new Error("person not found in your company");
  if (m.orgRole === "owner") throw new Error("the owner access cannot be changed");
  return m;
}

/** Keep the user row's "active company" mirror in step when the membership it points at changes. */
async function mirror(tx: Pick<Database, "update">, userId: string, businessId: string, orgRole: OrgRole) {
  await tx.update(users).set({ orgRole }).where(and(eq(users.id, userId), eq(users.businessId, businessId)));
}

export async function setMemberRole(db: Database, actor: Actor, userId: string, orgRole: OrgRole) {
  assertCan(actor, "team.manage");
  if (!INVITABLE.includes(orgRole)) throw new Error("choose admin, approver, maker or viewer");
  const m = await target(db, actor, userId);
  if (m.orgRole === orgRole) return;
  // Approver and admin access is money power: only the owner gives it or takes it away.
  if (POWERFUL.includes(orgRole) || POWERFUL.includes(m.orgRole)) assertCan(actor, "team.grant");
  await db.transaction(async (tx) => {
    await tx.update(memberships).set({ orgRole }).where(eq(memberships.id, m.id));
    await mirror(tx, userId, m.businessId, orgRole);
    await tx.insert(auditLog).values({ actorId: actor.id, action: "member.role_changed", entity: "user", entityId: userId, before: { orgRole: m.orgRole }, after: { orgRole, businessId: m.businessId } });
  });
}

/**
 * Suspending takes the person out of THIS company at once. If they belong to another, they stay signed in and land there;
 * if not, their sessions end. Their history stays intact.
 */
export async function setSuspended(db: Database, actor: Actor, userId: string, suspended: boolean, now = new Date()) {
  assertCan(actor, "team.manage");
  const m = await target(db, actor, userId);
  if (POWERFUL.includes(m.orgRole)) assertCan(actor, "team.grant");
  await db.transaction(async (tx) => {
    await tx.update(memberships).set({ suspendedAt: suspended ? now : null }).where(eq(memberships.id, m.id));
    if (suspended) {
      const [other] = await tx.select().from(memberships).where(and(eq(memberships.userId, userId), ne(memberships.businessId, m.businessId)));
      const live = other && !other.suspendedAt ? other : undefined;
      if (live) await activate(tx, userId, live.businessId, live.orgRole);
      else await tx.delete(session).where(eq(session.userId, userId));
    }
    await tx.insert(auditLog).values({ actorId: actor.id, action: suspended ? "member.suspended" : "member.reactivated", entity: "user", entityId: userId, after: { businessId: m.businessId } });
  });
}

/** Make a company the one the person is working in. The business's kind decides whether they are acting as seller, buyer or financier. */
async function activate(tx: Pick<Database, "select" | "update">, userId: string, businessId: string, orgRole: OrgRole) {
  const [b] = await tx.select({ kind: businesses.kind }).from(businesses).where(eq(businesses.id, businessId));
  const kind = b?.kind && ["seller", "buyer", "financier"].includes(b.kind) ? (b.kind as "seller" | "buyer" | "financier") : undefined;
  await tx.update(users).set({ businessId, orgRole, ...(kind ? { role: kind } : {}) }).where(eq(users.id, userId));
}

export async function switchCompany(db: Database, userId: string, businessId: string) {
  const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.businessId, businessId)));
  if (!m || m.suspendedAt) throw new Error("you do not have access to that company");
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!["seller", "buyer", "financier"].includes(u.role)) throw new Error("platform staff do not belong to companies");
  await db.transaction(async (tx) => {
    await activate(tx, userId, businessId, m.orgRole);
    await tx.insert(auditLog).values({ actorId: userId, action: "member.switched_company", entity: "business", entityId: businessId });
  });
}

/** The companies this person can work in, for the switcher. */
export const myCompanies = (db: Database, userId: string) =>
  db.select({ id: businesses.id, name: businesses.displayName, legalName: businesses.legalName, kind: businesses.kind, orgRole: memberships.orgRole, suspendedAt: memberships.suspendedAt })
    .from(memberships).innerJoin(businesses, eq(businesses.id, memberships.businessId)).where(eq(memberships.userId, userId)).orderBy(asc(memberships.createdAt));

/** A person who is locked out gets a reset link at their OWN email. Nobody ever types another person's password. */
export async function requestMemberReset(db: Database, actor: Actor, userId: string, send: (email: string) => Promise<void>) {
  assertCan(actor, "team.manage");
  const m = await target(db, actor, userId);
  if (POWERFUL.includes(m.orgRole)) assertCan(actor, "team.grant");
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  await send(u.email);
  await db.insert(auditLog).values({ actorId: actor.id, action: "member.reset_link_sent", entity: "user", entityId: userId });
}

// ---- ownership: offered by the owner, accepted by the recipient ----

export async function offerOwnership(db: Database, actor: Actor, toUserId: string, now = new Date()) {
  const businessId = need(actor);
  if (roleOf(actor) !== "owner") throw new Error("only the owner can transfer ownership");
  const m = await target(db, actor, toUserId);
  if (m.suspendedAt) throw new Error("that person is suspended");
  if (!POWERFUL.includes(m.orgRole)) throw new Error("ownership can be offered to an admin or an approver");
  await db.transaction(async (tx) => {
    await tx.update(ownershipTransfers).set({ status: "cancelled" }).where(and(eq(ownershipTransfers.businessId, businessId), eq(ownershipTransfers.status, "pending")));
    await tx.insert(ownershipTransfers).values({ businessId, fromUserId: actor.id, toUserId, expiresAt: new Date(now.getTime() + TRANSFER_DAYS * 86_400_000) });
    await tx.insert(auditLog).values({ actorId: actor.id, action: "ownership.offered", entity: "business", entityId: businessId, after: { toUserId } });
  });
}

export async function cancelOwnershipOffer(db: Database, actor: Actor) {
  const businessId = need(actor);
  if (roleOf(actor) !== "owner") throw new Error("only the owner can cancel the offer");
  await db.update(ownershipTransfers).set({ status: "cancelled" }).where(and(eq(ownershipTransfers.businessId, businessId), eq(ownershipTransfers.status, "pending")));
}

/** The recipient accepts: they become the owner, the previous owner becomes an admin. Exactly one owner at all times. */
export async function acceptOwnership(db: Database, actor: Actor, now = new Date()) {
  const businessId = need(actor);
  await db.transaction(async (tx) => {
    const [t] = await tx.select().from(ownershipTransfers).where(and(eq(ownershipTransfers.businessId, businessId), eq(ownershipTransfers.toUserId, actor.id), eq(ownershipTransfers.status, "pending"))).for("update");
    if (!t || t.expiresAt <= now) throw new Error("there is no ownership offer waiting for you");
    const [from] = await tx.select().from(memberships).where(and(eq(memberships.userId, t.fromUserId), eq(memberships.businessId, businessId)));
    if (!from || from.orgRole !== "owner") throw new Error("the owner has changed since this was offered");
    await tx.update(memberships).set({ orgRole: "owner" }).where(and(eq(memberships.userId, actor.id), eq(memberships.businessId, businessId)));
    await tx.update(memberships).set({ orgRole: "admin" }).where(eq(memberships.id, from.id));
    await mirror(tx, actor.id, businessId, "owner");
    await mirror(tx, t.fromUserId, businessId, "admin");
    await tx.update(ownershipTransfers).set({ status: "accepted" }).where(eq(ownershipTransfers.id, t.id));
    await tx.insert(auditLog).values({ actorId: actor.id, action: "ownership.accepted", entity: "business", entityId: businessId, before: { owner: t.fromUserId }, after: { owner: actor.id } });
  });
}

export async function pendingOwnership(db: Database, businessId: string, now = new Date()) {
  const [t] = await db.select().from(ownershipTransfers).where(and(eq(ownershipTransfers.businessId, businessId), eq(ownershipTransfers.status, "pending"))).orderBy(desc(ownershipTransfers.createdAt));
  return t && t.expiresAt > now ? t : null;
}

// ---- company profile ----

export async function updateCompany(db: Database, actor: Actor, p: { displayName: string; phone?: string; city?: string; industry?: string }) {
  assertCan(actor, "company.edit");
  const name = p.displayName.trim();
  if (name.length < 2 || name.length > 60) throw new Error("the company name must be 2 to 60 characters");
  await db.update(businesses).set({ displayName: name, phone: p.phone?.trim() || null, city: p.city?.trim() || null, industry: p.industry?.trim() || null }).where(eq(businesses.id, need(actor)));
}

export async function setApps(db: Database, actor: Actor, picks: string[]) {
  assertCan(actor, "apps.manage");
  await db.update(businesses).set({ apps: cleanSelection(actor.role, picks) }).where(eq(businesses.id, need(actor)));
}

export async function setCompanyLogo(db: Database, actor: Actor, bytes: Buffer, mime: string) {
  assertCan(actor, "company.edit");
  const { ref } = await putLogo(bytes, mime);
  await db.update(businesses).set({ logoRef: ref }).where(eq(businesses.id, need(actor)));
  return ref;
}

export async function completeSetup(db: Database, actor: Actor, now = new Date()) {
  assertCan(actor, "company.edit");
  const [b] = await db.select({ name: businesses.displayName }).from(businesses).where(eq(businesses.id, need(actor)));
  if (!b?.name) throw new Error("set the company name first");
  await db.update(businesses).set({ setupCompletedAt: now }).where(eq(businesses.id, need(actor)));
}

/** Dual control: when on, even an approver's own commitments wait for a different approver. Owner only; audited. */
export async function setDualControl(db: Database, actor: Actor, on: boolean) {
  assertCan(actor, "approval.settings");
  const businessId = need(actor);
  await db.transaction(async (tx) => {
    await tx.update(businesses).set({ dualControl: on }).where(eq(businesses.id, businessId));
    await tx.insert(auditLog).values({ actorId: actor.id, action: "company.dual_control", entity: "business", entityId: businessId, after: { on } });
  });
}
