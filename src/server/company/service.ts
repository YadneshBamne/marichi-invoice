// Company workspace: profile, apps, and the people inside it (owner -> managers -> members) with owner-issued credentials.
import { randomInt } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { account, auditLog, businesses, session, users } from "../db/schema";
import { cleanSelection } from "../../lib/apps";
import { assertCan } from "../permissions";
import { putLogo } from "../vault";

export type Actor = { id: string; role: string; orgRole: string; businessId: string | null };
export type Hash = (password: string) => Promise<string>;
type Staffer = "manager" | "member";

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/l/I)
/** Temporary password the owner hands over. Cryptographically random, 12 characters. */
export const tempPassword = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

const need = (a: Actor) => { if (!a.businessId) throw new Error("no company linked to this account"); return a.businessId; };

export const listTeam = (db: Database, businessId: string) =>
  db.select({ id: users.id, name: users.name, email: users.email, orgRole: users.orgRole, suspendedAt: users.suspendedAt, mustChangePassword: users.mustChangePassword, createdAt: users.createdAt })
    .from(users).where(eq(users.businessId, businessId)).orderBy(asc(users.createdAt));

/** The target must belong to the actor's company, not be the actor, and not be an owner. */
async function target(db: Database, a: Actor, userId: string) {
  const businessId = need(a);
  if (userId === a.id) throw new Error("you cannot change your own access here");
  const [u] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.businessId, businessId)));
  if (!u) throw new Error("person not found in your company");
  if (u.orgRole === "owner") throw new Error("the owner access cannot be changed");
  return u;
}

export async function addMember(db: Database, hash: Hash, actor: Actor, p: { name: string; email: string; orgRole: Staffer; password?: string }) {
  assertCan(actor, "team.manage");
  const businessId = need(actor);
  const email = p.email.trim().toLowerCase();
  if (p.name.trim().length < 2) throw new Error("enter the person name");
  if (!["manager", "member"].includes(p.orgRole)) throw new Error("choose manager or member");
  const password = p.password?.trim() || tempPassword();
  if (password.length < 10) throw new Error("the password must be at least 10 characters");
  const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (clash) throw new Error("someone already has an account with this email");
  const passwordHash = await hash(password);
  const created = await db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({
      name: p.name.trim(), email, emailVerified: true, role: actor.role as never, businessId, orgRole: p.orgRole, mustChangePassword: true, invitedBy: actor.id,
    }).returning();
    await tx.insert(account).values({ accountId: u.id, providerId: "credential", userId: u.id, password: passwordHash });
    await tx.insert(auditLog).values({ actorId: actor.id, action: "member.added", entity: "user", entityId: u.id, after: { email, orgRole: p.orgRole } });
    return u;
  });
  return { user: created, password };
}

export async function resetMemberPassword(db: Database, hash: Hash, actor: Actor, userId: string, password?: string) {
  assertCan(actor, "team.manage");
  const u = await target(db, actor, userId);
  const pw = password?.trim() || tempPassword();
  if (pw.length < 10) throw new Error("the password must be at least 10 characters");
  const passwordHash = await hash(pw);
  await db.transaction(async (tx) => {
    await tx.update(account).set({ password: passwordHash }).where(and(eq(account.userId, u.id), eq(account.providerId, "credential")));
    await tx.update(users).set({ mustChangePassword: true }).where(eq(users.id, u.id));
    await tx.delete(session).where(eq(session.userId, u.id)); // sign them out everywhere
    await tx.insert(auditLog).values({ actorId: actor.id, action: "member.password_reset", entity: "user", entityId: u.id });
  });
  return { password: pw };
}

export async function setMemberRole(db: Database, actor: Actor, userId: string, orgRole: Staffer) {
  assertCan(actor, "team.manage");
  if (!["manager", "member"].includes(orgRole)) throw new Error("choose manager or member");
  const u = await target(db, actor, userId);
  if (u.orgRole === orgRole) return;
  await db.update(users).set({ orgRole }).where(eq(users.id, u.id));
  await db.insert(auditLog).values({ actorId: actor.id, action: "member.role_changed", entity: "user", entityId: u.id, before: { orgRole: u.orgRole }, after: { orgRole } });
}

/** Suspending blocks every page immediately and ends their sessions. Their history stays intact. */
export async function setSuspended(db: Database, actor: Actor, userId: string, suspended: boolean, now = new Date()) {
  assertCan(actor, "team.manage");
  const u = await target(db, actor, userId);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ suspendedAt: suspended ? now : null }).where(eq(users.id, u.id));
    if (suspended) await tx.delete(session).where(eq(session.userId, u.id));
    await tx.insert(auditLog).values({ actorId: actor.id, action: suspended ? "member.suspended" : "member.reactivated", entity: "user", entityId: u.id });
  });
}

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
