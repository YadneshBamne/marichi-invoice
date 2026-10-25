// What a person can ask us about their own data, and what we delete on a schedule. The law is named by the country (countries pack);
// the mechanism is the same everywhere: a request with a due date, answered from what we hold or worked by staff.
//   access     answered at once, from the account the person is signed in to
//   correction staff fix it, or say why not
//   erasure    the account is closed and the person's details removed; records the law makes us keep stay, without a name on the account
//   objection  staff stop the optional uses, or say why not
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  account, agreements, auditLog, businesses, consents, financingOffers, invitations, invoiceCollections, invoices, memberships, notificationPreferences,
  notifications, phoneOtps, privacyRequests, reportRuns, session, ticketMessages, tickets, twoFactor, users, verification, webhookDeliveries, externalCalls,
} from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyStaff, notifyUser, send } from "../notify";
import { ACCOUNTS, balance } from "../ledger/accounts";
import { market } from "../../lib/countries";
import { PRIVACY } from "./rules";

export { PRIVACY };
export const KINDS = {
  access: "Get a copy of my data",
  correction: "Correct my data",
  erasure: "Delete my account and data",
  objection: "Stop optional uses of my data",
} as const;
export type Kind = keyof typeof KINDS;
const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
export type Person = { id: string; role: string };
export type Staff = { id: string; role: string };
const STAFF_ROLES = ["admin", "compliance"];
const assertStaff = (s: Staff) => { if (!STAFF_ROLES.includes(s.role)) throw new Error("forbidden"); };

/** What the law lets us keep, in words for the person. */
export const keptNote = () => `Records the law requires us to keep (verification, signed agreements, payments and ledger entries) stay for ${market().privacy.retentionYears} years after the relationship ends, as ${market().privacy.law} and the financial rules allow. They are not used for anything else.`;

// ---- a person's requests

export async function openRequest(db: Database, who: Person, p: { kind: string; details?: string }, gw: Adapters = gateway, now = new Date()) {
  if (!(p.kind in KINDS)) throw new Error("choose what you would like to ask for");
  const kind = p.kind as Kind, details = (p.details ?? "").trim();
  if (details.length > 2000) throw new Error("please keep the details under 2,000 characters");
  if ((kind === "correction" || kind === "objection") && details.length < 10) throw new Error(kind === "correction" ? "say what is wrong and what it should be" : "say which uses you want us to stop");
  const [open] = await db.select({ id: privacyRequests.id }).from(privacyRequests).where(and(eq(privacyRequests.userId, who.id), eq(privacyRequests.kind, kind), eq(privacyRequests.status, "received")));
  if (open) throw new Error("you already have an open request of this kind");
  const [r] = await db.insert(privacyRequests).values({ userId: who.id, kind, details: details || null, dueAt: new Date(now.getTime() + PRIVACY.responseDays * DAY), createdAt: now }).returning();
  await db.insert(auditLog).values({ actorId: who.id, action: "privacy.request", entity: "user", entityId: who.id, after: { requestId: r.id, kind } });
  if (kind === "access") return fulfilAccess(db, r.id, gw, now);
  await notifyUser(db, who.id, "privacy_request_received", { kind: KINDS[kind], due: day(r.dueAt) }, gw, now);
  await notifyStaff(db, ["admin", "compliance"], "privacy_request_new", { kind: KINDS[kind], due: day(r.dueAt), link: "/admin/privacy" }, gw, now);
  return r;
}

/** Everything we hold about this person themselves (not their company's records). Secrets, password hashes and session tokens are never included. */
export async function accessExport(db: Database, userId: string, now = new Date()) {
  const [me] = await db.select({ name: users.name, email: users.email, phone: users.phone, phoneVerified: users.phoneVerified, role: users.role, createdAt: users.createdAt, termsVersion: users.termsVersion, termsAcceptedAt: users.termsAcceptedAt }).from(users).where(eq(users.id, userId));
  if (!me) throw new Error("no such person");
  const [companies, consent, sessions, sent, prefs, activity, raised, said, signed, history] = await Promise.all([
    db.select({ company: businesses.legalName, role: memberships.orgRole, since: memberships.createdAt }).from(memberships).innerJoin(businesses, eq(businesses.id, memberships.businessId)).where(eq(memberships.userId, userId)),
    db.select({ purpose: consents.purpose, text: consents.text, at: consents.createdAt }).from(consents).where(eq(consents.userId, userId)),
    db.select({ signedInAt: session.createdAt, expiresAt: session.expiresAt, ip: session.ipAddress, device: session.userAgent }).from(session).where(eq(session.userId, userId)),
    db.select({ template: notifications.template, channel: notifications.channel, subject: notifications.subject, status: notifications.status, at: notifications.createdAt }).from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(2000),
    db.select({ channel: notificationPreferences.channel, enabled: notificationPreferences.enabled }).from(notificationPreferences).where(eq(notificationPreferences.userId, userId)),
    db.select({ action: auditLog.action, entity: auditLog.entity, entityId: auditLog.entityId, at: auditLog.createdAt }).from(auditLog).where(eq(auditLog.actorId, userId)).orderBy(desc(auditLog.createdAt)).limit(2000),
    db.select({ kind: tickets.kind, subject: tickets.subject, description: tickets.description, status: tickets.status, at: tickets.createdAt }).from(tickets).where(eq(tickets.raisedBy, userId)),
    db.select({ message: ticketMessages.body, at: ticketMessages.createdAt }).from(ticketMessages).where(eq(ticketMessages.authorId, userId)),
    db.select({ agreement: agreements.kind, signedAt: agreements.signedAt, ip: agreements.signedIp, device: agreements.signedUserAgent }).from(agreements).where(eq(agreements.signedBy, userId)),
    db.select({ kind: privacyRequests.kind, status: privacyRequests.status, at: privacyRequests.createdAt, resolution: privacyRequests.resolution }).from(privacyRequests).where(eq(privacyRequests.userId, userId)),
  ]);
  return {
    generatedAt: now.toISOString(),
    about: `The personal data we hold about you. Your company's own records (invoices, verification, payments) belong to the company and are not in this copy. ${keptNote()}`,
    profile: me, companies, consents: consent, signIns: sessions, messagesSent: sent, notificationChoices: prefs, yourActivity: activity,
    supportRequests: raised, supportMessages: said, agreementsSigned: signed, privacyRequests: history,
  };
}

async function fulfilAccess(db: Database, requestId: string, gw: Adapters, now: Date) {
  const [r] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, requestId));
  const data = await accessExport(db, r.userId, now);
  const note = `Your copy is ready under Settings, then Privacy. It stays available for ${PRIVACY.exportDays} days.`;
  const [done] = await db.update(privacyRequests).set({ status: "completed", exportData: data, completedAt: now, resolution: note }).where(eq(privacyRequests.id, requestId)).returning();
  await notifyUser(db, r.userId, "privacy_request_done", { kind: KINDS.access, outcome: "ready", note }, gw, now);
  return done;
}

export const myRequests = (db: Database, userId: string) => db.select().from(privacyRequests).where(eq(privacyRequests.userId, userId)).orderBy(desc(privacyRequests.createdAt));

// ---- staff

export async function queue(db: Database, now = new Date()) {
  const rows = await db.select({ r: privacyRequests, name: users.name, email: users.email }).from(privacyRequests).innerJoin(users, eq(users.id, privacyRequests.userId)).orderBy(desc(privacyRequests.createdAt)).limit(200);
  return rows.map((x) => ({ ...x, overdue: x.r.status === "received" && x.r.dueAt < now }));
}

export async function resolveRequest(db: Database, staff: Staff, requestId: string, p: { outcome: "completed" | "refused"; note: string }, gw: Adapters = gateway, now = new Date()) {
  assertStaff(staff);
  const note = p.note.trim();
  if (!note) throw new Error("say what was done, or why not");
  const [r] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, requestId));
  if (!r || r.status !== "received") throw new Error("this request is already answered");
  if (r.kind === "access") throw new Error("copy requests are answered automatically");
  if (r.kind === "erasure" && p.outcome === "completed") throw new Error("use Erase account to complete a deletion request");
  await db.update(privacyRequests).set({ status: p.outcome, resolution: note, handledBy: staff.id, completedAt: now }).where(eq(privacyRequests.id, requestId));
  await db.insert(auditLog).values({ actorId: staff.id, action: `privacy.${p.outcome}`, entity: "user", entityId: r.userId, after: { requestId, kind: r.kind } });
  await notifyUser(db, r.userId, "privacy_request_done", { kind: KINDS[r.kind as Kind], outcome: p.outcome === "completed" ? "done" : "declined", note }, gw, now);
}

/** Why this person's account cannot be closed yet. Empty means it can. */
export async function erasureBlockers(db: Database, userId: string) {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) throw new Error("no such person");
  const out: string[] = [];
  if (u.role === "admin") {
    const [others] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "admin"), ne(users.id, userId), isNull(users.suspendedAt)));
    if (!others.n) out.push("this is the only active administrator");
  }
  // A company this person alone owns must have nothing in flight: nobody else could finish it.
  const owned = await db.select({ id: memberships.businessId, name: businesses.legalName }).from(memberships).innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgRole, "owner"), isNull(memberships.suspendedAt)));
  for (const b of owned) {
    const [other] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.businessId, b.id), eq(memberships.orgRole, "owner"), ne(memberships.userId, userId), isNull(memberships.suspendedAt)));
    if (other) continue;
    const [open] = await db.select({ n: sql<number>`count(*)::int` }).from(invoiceCollections).innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId))
      .where(and(isNull(invoiceCollections.closedAt), or(eq(invoices.sellerId, b.id), eq(invoices.buyerId, b.id))));
    if (open.n) out.push(`${b.name} has ${open.n} financed invoice${open.n === 1 ? "" : "s"} still open`);
    const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(financingOffers).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
      .where(and(eq(financingOffers.status, "accepted"), eq(invoices.status, "eligible"), eq(invoices.sellerId, b.id)));
    if (pending.n) out.push(`${b.name} has an accepted offer that has not been paid out`);
    const money = (await balance(db, ACCOUNTS.financierFunds(b.id))) + (await balance(db, ACCOUNTS.financierDeployed(b.id)));
    if (money !== 0n) out.push(`${b.name} still has money held or deployed as a financier`);
  }
  return out;
}

/** Close the account and remove the person's details. Refuses while the blockers above exist. */
export async function eraseAccount(db: Database, staff: Staff, requestId: string, gw: Adapters = gateway, now = new Date()) {
  assertStaff(staff);
  const [r] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, requestId));
  if (!r || r.status !== "received" || r.kind !== "erasure") throw new Error("this is not an open deletion request");
  const blockers = await erasureBlockers(db, r.userId);
  if (blockers.length) throw new Error(`cannot delete yet: ${blockers.join("; ")}`);
  const resolution = `Your account was closed and your personal details removed. ${keptNote()}`;
  const old = await db.transaction(async (tx) => {
    const [u] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, r.userId)).for("update");
    await tx.update(users).set({ name: "Former user", email: `erased-${u.id}@erased.invalid`, phone: null, phoneVerified: false, image: null, emailVerified: false, twoFactorEnabled: false, suspendedAt: now, mustChangePassword: false }).where(eq(users.id, u.id));
    await tx.delete(session).where(eq(session.userId, u.id));
    await tx.delete(account).where(eq(account.userId, u.id));
    await tx.delete(twoFactor).where(eq(twoFactor.userId, u.id));
    await tx.delete(phoneOtps).where(eq(phoneOtps.userId, u.id));
    await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, u.id));
    await tx.delete(notifications).where(eq(notifications.userId, u.id));
    await tx.delete(memberships).where(eq(memberships.userId, u.id));
    await tx.delete(invitations).where(and(eq(invitations.email, u.email), eq(invitations.status, "pending")));
    await tx.update(privacyRequests).set({ status: "completed", resolution, handledBy: staff.id, completedAt: now }).where(eq(privacyRequests.id, requestId));
    await tx.update(privacyRequests).set({ exportData: null }).where(eq(privacyRequests.userId, u.id));
    await tx.insert(auditLog).values({ actorId: staff.id, action: "privacy.erase", entity: "user", entityId: u.id, after: { requestId } });
    return u;
  });
  // The last notice goes to the address we just removed from the account; the sweep deletes this row within days.
  await send(db, gw, [{ id: old.id, email: old.email, phone: null, phoneVerified: false }], "privacy_request_done", { kind: KINDS.erasure, outcome: "done", note: resolution }, now);
}

// ---- retention

/**
 * Delete what has outlived its purpose: expired sign-ins and codes, old message copies, report files, webhook records, call logs, and
 * data copies nobody downloaded. Safe to run twice. Records the law makes us keep are never touched here.
 * ponytail: each delete returns its ids to count them; switch to a count-only statement if a table ever holds millions of due rows.
 */
export async function runRetention(db: Database, now = new Date()) {
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const n = {
    sessions: (await db.delete(session).where(lt(session.expiresAt, ago(30))).returning({ id: session.id })).length,
    verifications: (await db.delete(verification).where(lt(verification.expiresAt, ago(7))).returning({ id: verification.id })).length,
    phoneCodes: (await db.delete(phoneOtps).where(lt(phoneOtps.expiresAt, ago(1))).returning({ id: phoneOtps.userId })).length,
    reportFiles: (await db.delete(reportRuns).where(lt(reportRuns.createdAt, ago(PRIVACY.reportRunDays))).returning({ id: reportRuns.id })).length,
    messages: (await db.delete(notifications).where(or(
      and(lt(notifications.createdAt, ago(PRIVACY.notificationDays)), inArray(notifications.status, ["sent", "delivered", "read", "failed"])),
      and(eq(notifications.template, "privacy_request_done"), lt(notifications.createdAt, ago(7)), ne(notifications.status, "queued")), // the notice sent to an erased address
    )).returning({ id: notifications.id })).length,
    webhooks: (await db.delete(webhookDeliveries).where(and(lt(webhookDeliveries.createdAt, ago(PRIVACY.webhookDays)), inArray(webhookDeliveries.status, ["delivered", "failed"]))).returning({ id: webhookDeliveries.id })).length,
    callLogs: (await db.delete(externalCalls).where(lt(externalCalls.createdAt, ago(PRIVACY.logDays))).returning({ id: externalCalls.idempotencyKey })).length,
    dataCopies: (await db.update(privacyRequests).set({ exportData: null }).where(and(isNotNull(privacyRequests.exportData), lt(privacyRequests.completedAt, ago(PRIVACY.exportDays)))).returning({ id: privacyRequests.id })).length,
  };
  if (Object.values(n).some((v) => v > 0)) await db.insert(auditLog).values({ action: "retention.sweep", entity: "system", entityId: "retention", after: n });
  return n;
}

/** The last sweep, for the staff page. */
export async function lastSweep(db: Database) {
  const [r] = await db.select().from(auditLog).where(eq(auditLog.action, "retention.sweep")).orderBy(desc(auditLog.createdAt)).limit(1);
  return r ? { at: r.createdAt, counts: r.after as Record<string, number> } : null;
}
