// Joining a company is by emailed link. The inviter chooses an email and a role; the invitee sets their own password and their own
// second factor. Nobody else ever knows a credential. Links are single-use, expire in 10 days, and only a hash is stored.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { account, auditLog, businesses, invitations, memberships, users, type OrgRole } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { appUrl } from "../notify";
import { render } from "../notify/templates";
import { assertCan, INVITABLE, ORG_ROLE_LABEL, POWERFUL } from "../permissions";
import type { Actor } from "./service";
import { PLATFORM_TERMS_VERSION } from "../agreements/templates";

export const INVITE_DAYS = 10;
export type Hash = (password: string) => Promise<string>;

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const need = (a: Actor) => { if (!a.businessId) throw new Error("no company linked to this account"); return a.businessId; };

/** An invitation to a powerful role can only be sent, resent or cancelled by the owner. */
function guard(actor: Actor, role: OrgRole) {
  assertCan(actor, "team.manage");
  if (POWERFUL.includes(role)) assertCan(actor, "team.grant");
}

async function email(gw: Adapters, p: { to: string; company: string; role: OrgRole; inviter: string; token: string }) {
  const link = `${appUrl()}/invite/${p.token}`;
  if (process.env.NODE_ENV !== "production") console.log(`[dev] invitation link for ${p.to}: ${link}`); // never shown to the inviter in the product
  const r = render("team_invite", "email", { company: p.company, role: ORG_ROLE_LABEL[p.role], inviter: p.inviter, link, days: String(INVITE_DAYS) });
  try {
    await gw.notify.send({ channel: "email", to: p.to, template: "team_invite", data: { company: p.company, link }, subject: r && "subject" in r ? r.subject : "You have been invited to Marichi", body: r?.body ?? link });
    return true;
  } catch { return false; } // the inviter can press Resend
}

async function companyName(db: Database, businessId: string) {
  const [b] = await db.select({ n: businesses.displayName, l: businesses.legalName }).from(businesses).where(eq(businesses.id, businessId));
  return b.n ?? b.l;
}

export async function inviteMember(db: Database, actor: Actor, p: { email: string; orgRole: OrgRole }, gw: Adapters = gateway, now = new Date()) {
  const businessId = need(actor);
  if (!INVITABLE.includes(p.orgRole)) throw new Error("choose admin, approver, maker or viewer");
  guard(actor, p.orgRole);
  const to = p.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("enter a valid email address");
  const [person] = await db.select({ id: users.id }).from(users).where(eq(users.email, to));
  if (person) {
    const [m] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, person.id), eq(memberships.businessId, businessId)));
    if (m) throw new Error("that person is already part of your company");
  }
  // A lapsed invitation must not block a new one.
  await db.update(invitations).set({ status: "cancelled" }).where(and(eq(invitations.businessId, businessId), eq(invitations.email, to), eq(invitations.status, "pending"), lte(invitations.expiresAt, now)));
  const [clash] = await db.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.businessId, businessId), eq(invitations.email, to), eq(invitations.status, "pending")));
  if (clash) throw new Error("that person is already invited. Use Resend to send the link again");
  const token = newToken();
  const [inv] = await db.insert(invitations).values({ businessId, email: to, orgRole: p.orgRole, tokenHash: sha(token), invitedBy: actor.id, expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000) }).returning();
  await db.insert(auditLog).values({ actorId: actor.id, action: "member.invited", entity: "business", entityId: businessId, after: { email: to, orgRole: p.orgRole } });
  const [me] = await db.select({ n: users.name }).from(users).where(eq(users.id, actor.id));
  const emailed = await email(gw, { to, company: await companyName(db, businessId), role: p.orgRole, inviter: me?.n ?? "A colleague", token });
  return { invitation: inv, emailed };
}

async function mine(db: Database, actor: Actor, id: string) {
  const businessId = need(actor);
  const [inv] = await db.select().from(invitations).where(and(eq(invitations.id, id), eq(invitations.businessId, businessId)));
  if (!inv || inv.status !== "pending") throw new Error("that invitation is no longer open");
  guard(actor, inv.orgRole);
  return inv;
}

export async function cancelInvitation(db: Database, actor: Actor, id: string) {
  const inv = await mine(db, actor, id);
  await db.update(invitations).set({ status: "cancelled" }).where(eq(invitations.id, inv.id));
  await db.insert(auditLog).values({ actorId: actor.id, action: "member.invite_cancelled", entity: "business", entityId: inv.businessId, after: { email: inv.email } });
}

/** A fresh link and a fresh ten days. The old link stops working. */
export async function resendInvitation(db: Database, actor: Actor, id: string, gw: Adapters = gateway, now = new Date()) {
  const inv = await mine(db, actor, id);
  const token = newToken();
  await db.update(invitations).set({ tokenHash: sha(token), expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000) }).where(eq(invitations.id, inv.id));
  const [me] = await db.select({ n: users.name }).from(users).where(eq(users.id, actor.id));
  const emailed = await email(gw, { to: inv.email, company: await companyName(db, inv.businessId), role: inv.orgRole, inviter: me?.n ?? "A colleague", token });
  await db.insert(auditLog).values({ actorId: actor.id, action: "member.invite_resent", entity: "business", entityId: inv.businessId, after: { email: inv.email } });
  return { emailed };
}

export async function listInvitations(db: Database, businessId: string, now = new Date()) {
  const rows = await db.select().from(invitations).where(and(eq(invitations.businessId, businessId), eq(invitations.status, "pending"))).orderBy(asc(invitations.createdAt));
  return rows.map((r) => ({ id: r.id, email: r.email, orgRole: r.orgRole, expiresAt: r.expiresAt, expired: r.expiresAt <= now }));
}

export type Preview = { state: "open" | "expired" | "used" | "cancelled"; company: string; orgRole: OrgRole; email: string; hasAccount: boolean; expiresAt: Date };

/** What the invitee sees before they commit. Returns null for a link we do not know. */
export async function previewInvitation(db: Database, token: string, now = new Date()): Promise<Preview | null> {
  const [inv] = await db.select().from(invitations).where(eq(invitations.tokenHash, sha(token)));
  if (!inv) return null;
  const [acct] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
  const state = inv.status === "accepted" ? "used" : inv.status === "cancelled" ? "cancelled" : inv.expiresAt <= now ? "expired" : "open";
  return { state, company: await companyName(db, inv.businessId), orgRole: inv.orgRole, email: inv.email, hasAccount: !!acct, expiresAt: inv.expiresAt };
}

async function open(db: Database, token: string, now: Date) {
  const [inv] = await db.select().from(invitations).where(eq(invitations.tokenHash, sha(token)));
  if (!inv || inv.status !== "pending") throw new Error("this invitation is not valid any more");
  if (inv.expiresAt <= now) throw new Error("this invitation has expired. Ask for a new one");
  return inv;
}

/** A new person: they choose their own name and password. Holding the emailed link is what proves the address is theirs. */
export async function acceptAsNewUser(db: Database, hash: Hash, token: string, p: { name: string; password: string }, now = new Date()) {
  const inv = await open(db, token, now);
  if (p.name.trim().length < 2) throw new Error("enter your name");
  if (p.password.length < 10) throw new Error("the password must be at least 10 characters");
  const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
  if (clash) throw new Error("you already have an account. Sign in to accept this invitation");
  const [b] = await db.select({ kind: businesses.kind }).from(businesses).where(eq(businesses.id, inv.businessId));
  const passwordHash = await hash(p.password);
  return db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({
      name: p.name.trim(), email: inv.email, emailVerified: true, role: (b?.kind as "seller" | "buyer" | "financier" | null) ?? "seller",
      businessId: inv.businessId, orgRole: inv.orgRole, invitedBy: inv.invitedBy, termsVersion: PLATFORM_TERMS_VERSION, termsAcceptedAt: now,
    }).returning();
    await tx.insert(account).values({ accountId: u.id, providerId: "credential", userId: u.id, password: passwordHash });
    await tx.insert(memberships).values({ userId: u.id, businessId: inv.businessId, orgRole: inv.orgRole, invitedBy: inv.invitedBy });
    await tx.update(invitations).set({ status: "accepted", acceptedAt: now, acceptedBy: u.id }).where(eq(invitations.id, inv.id));
    await tx.insert(auditLog).values({ actorId: u.id, action: "member.joined", entity: "business", entityId: inv.businessId, after: { email: inv.email, orgRole: inv.orgRole } });
    return { userId: u.id, email: inv.email };
  });
}

/** Someone who already has an account: they must be signed in as the invited address. They gain a second company and switch to it. */
export async function acceptAsExistingUser(db: Database, userId: string, token: string, now = new Date()) {
  const inv = await open(db, token, now);
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.email.toLowerCase() !== inv.email) throw new Error("this invitation was sent to a different email address");
  if (!["seller", "buyer", "financier"].includes(u.role)) throw new Error("platform staff accounts cannot join a company");
  const [b] = await db.select({ kind: businesses.kind }).from(businesses).where(eq(businesses.id, inv.businessId));
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ userId, businessId: inv.businessId, orgRole: inv.orgRole, invitedBy: inv.invitedBy }).onConflictDoNothing();
    await tx.update(users).set({ businessId: inv.businessId, orgRole: inv.orgRole, ...(b?.kind ? { role: b.kind as "seller" | "buyer" | "financier" } : {}) }).where(eq(users.id, userId));
    await tx.update(invitations).set({ status: "accepted", acceptedAt: now, acceptedBy: userId }).where(eq(invitations.id, inv.id));
    await tx.insert(auditLog).values({ actorId: userId, action: "member.joined", entity: "business", entityId: inv.businessId, after: { email: inv.email, orgRole: inv.orgRole, existingAccount: true } });
  });
}
