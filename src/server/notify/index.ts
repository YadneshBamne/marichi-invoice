import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { memberships, notificationPreferences, notifications, users } from "../db/schema";
import { gateway, type Adapters, type Channel } from "../integrations/gateway";
import { render, TEMPLATES } from "./templates";

type Role = typeof users.$inferSelect.role;
type Recipient = { id: string; email: string; phone: string | null; phoneVerified: boolean };

export const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [60, 300, 1800, 7200]; // after attempt 1..4; the 5th failure is final
const STUCK_AFTER_MS = 10 * 60_000; // a `sending` row older than this means the worker died mid-send
export const appUrl = () => (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** Relative links in template data become absolute so they work in an email/SMS. */
const absolutize = (data: Record<string, string>) =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === "link" && v.startsWith("/") ? appUrl() + v : v]));

/** Which channels this user gets for this template. Critical = every channel they have; otherwise respect opt-outs. */
export function channelsFor(template: string, u: Recipient, optedOut: Set<string>): Channel[] {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown notification template: ${template}`);
  const out: Channel[] = [];
  if (t.critical || !optedOut.has("email")) out.push("email");
  if (t.sms && u.phone && u.phoneVerified && (t.critical || !optedOut.has("sms"))) out.push("sms");
  return out;
}

/** Send to people we already have addresses for, without looking them up again (used after an erasure, when the account no longer holds the address). */
export async function send(db: Database, gw: Adapters, to: Recipient[], template: string, data: Record<string, string>, now: Date) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown notification template: ${template}`);
  const d = absolutize(data);
  const ids = to.map((u) => u.id);
  const prefs = ids.length ? await db.select().from(notificationPreferences).where(and(inArray(notificationPreferences.userId, ids), eq(notificationPreferences.enabled, false))) : [];
  const created: string[] = [];
  let reached = 0;
  for (const u of to) {
    const off = new Set(prefs.filter((p) => p.userId === u.id).map((p) => p.channel));
    const channels = channelsFor(template, u, off);
    for (const channel of channels) {
      const r = render(template, channel, d)!;
      const [row] = await db.insert(notifications).values({
        userId: u.id, channel, template, critical: !!t.critical, toAddress: channel === "email" ? u.email : u.phone,
        subject: "subject" in r ? r.subject : null, body: r.body, nextAttemptAt: now,
      }).returning({ id: notifications.id });
      created.push(row.id);
    }
    if (channels.length) reached++;
  }
  // Try right away; whatever fails stays queued for the worker's retry.
  for (const id of created) await attempt(db, gw, id, now, d);
  return reached;
}

/** Notify every user of a business. Never throws on delivery trouble: a flaky provider must not undo a state change. */
export async function notifyBusiness(db: Database, businessId: string, template: string, data: Record<string, string>, gw: Adapters = gateway, now = new Date()) {
  // Everyone who belongs to the company, including people whose active company is a different one right now.
  const us = await db.select({ id: users.id, email: users.email, phone: users.phone, phoneVerified: users.phoneVerified }).from(users)
    .where(or(
      and(eq(users.businessId, businessId), isNull(users.suspendedAt)),
      sql`${users.id} in (select ${memberships.userId} from ${memberships} where ${memberships.businessId} = ${businessId} and ${memberships.suspendedAt} is null)`,
    ));
  return send(db, gw, us, template, data, now);
}

/** Notify one person. */
export async function notifyUser(db: Database, userId: string, template: string, data: Record<string, string>, gw: Adapters = gateway, now = new Date()) {
  const us = await db.select({ id: users.id, email: users.email, phone: users.phone, phoneVerified: users.phoneVerified }).from(users).where(eq(users.id, userId));
  return send(db, gw, us, template, data, now);
}

/** Notify internal staff (e.g. relationship-manager escalation, compliance alerts). */
export async function notifyStaff(db: Database, roles: Role[], template: string, data: Record<string, string>, gw: Adapters = gateway, now = new Date()) {
  const us = await db.select({ id: users.id, email: users.email, phone: users.phone, phoneVerified: users.phoneVerified }).from(users).where(inArray(users.role, roles));
  return send(db, gw, us, template, data, now);
}

/**
 * One delivery attempt. Claiming is a conditional UPDATE, so the inline send and the worker can never both send the same row.
 * Failure -> exponential backoff; after MAX_ATTEMPTS the row is `failed` for good.
 */
async function attempt(db: Database, gw: Adapters, id: string, now: Date, data?: Record<string, string>) {
  const stuck = new Date(now.getTime() - STUCK_AFTER_MS);
  const [row] = await db.update(notifications).set({ status: "sending", claimedAt: now })
    .where(and(eq(notifications.id, id), or(eq(notifications.status, "queued"), and(eq(notifications.status, "sending"), lte(notifications.claimedAt, stuck))))).returning();
  if (!row) return false;
  try {
    const t = TEMPLATES[row.template];
    const res = await gw.notify.send({
      channel: row.channel as Channel, to: row.toAddress!, template: row.template, data: data ?? {}, subject: row.subject ?? undefined,
      body: row.body ?? "", dltTemplateId: row.channel === "sms" ? t?.sms?.dltTemplateId : undefined,
    });
    await db.update(notifications).set({ status: "sent", sentAt: now, providerRef: res?.providerRef ?? null, error: null }).where(eq(notifications.id, id));
    return true;
  } catch (e) {
    const attempts = row.attempts + 1;
    await db.update(notifications).set({
      attempts, error: String((e as Error).message).slice(0, 300),
      status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      nextAttemptAt: new Date(now.getTime() + (BACKOFF_SECONDS[attempts - 1] ?? 7200) * 1000),
    }).where(eq(notifications.id, id));
    return false;
  }
}

/** Worker: retry everything that's due (including rows orphaned in `sending` by a crash). */
export async function deliverQueued(db: Database, gw: Adapters = gateway, now = new Date()) {
  const stuck = new Date(now.getTime() - STUCK_AFTER_MS);
  const due = await db.select({ id: notifications.id }).from(notifications).where(or(
    and(eq(notifications.status, "queued"), lte(notifications.nextAttemptAt, now)),
    and(eq(notifications.status, "sending"), lte(notifications.claimedAt, stuck)),
  )).limit(200);
  let sent = 0;
  // The template data isn't stored (only the rendered message), and the gateway only needs the rendered subject/body.
  for (const r of due) if (await attempt(db, gw, r.id, now)) sent++;
  return sent;
}

const RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/** Provider delivery receipt (webhook). Idempotent and monotonic: a late `delivered` never downgrades `read`. */
export async function recordDeliveryReceipt(db: Database, p: { providerRef: string; status: "delivered" | "read" | "failed"; at?: Date }) {
  const [n] = await db.select().from(notifications).where(eq(notifications.providerRef, p.providerRef));
  if (!n) throw new Error("unknown provider reference");
  const at = p.at ?? new Date();
  if (p.status === "failed") {
    if (n.status === "sent" || n.status === "sending") await db.update(notifications).set({ status: "failed", error: "provider reported delivery failure" }).where(eq(notifications.id, n.id));
    return;
  }
  if ((RANK[n.status] ?? -1) >= RANK[p.status]) return;
  await db.update(notifications).set(p.status === "delivered" ? { status: "delivered", deliveredAt: at } : { status: "read", readAt: at, deliveredAt: n.deliveredAt ?? at })
    .where(eq(notifications.id, n.id));
}

// ---- preferences ----

export async function setPreference(db: Database, userId: string, channel: Channel, enabled: boolean) {
  await db.insert(notificationPreferences).values({ userId, channel, enabled })
    .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.channel], set: { enabled } });
}

export async function getPreferences(db: Database, userId: string) {
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  const off = (c: Channel) => rows.some((r) => r.channel === c && !r.enabled);
  return { email: !off("email"), sms: !off("sms") };
}

