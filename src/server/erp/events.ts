// Outbound webhooks: status changes pushed to the company's own systems. Deliveries are queued first and sent by the worker,
// so a slow or broken endpoint can never hold up a payout or a repayment. Each delivery is signed so the receiver can trust it:
//   x-marichi-signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>" with the endpoint secret>
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { assertCan } from "../permissions";

export const EVENT_TYPES = ["offer.created", "invoice.confirmed", "invoice.disputed", "invoice.financed", "invoice.payment_received", "invoice.paid", "invoice.overdue", "invoice.credit_note", "ping"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
const BACKOFF_MIN = [1, 5, 30, 120, 720]; // after attempt 1..5; the 6th failure is final
export const MAX_ATTEMPTS = 6;

type Actor = { id: string; role: string; orgRole: string; businessId: string | null };

/** https only, and never an address inside the network (plain http to localhost is allowed outside production, for testing). */
export function checkUrl(raw: string, production = process.env.NODE_ENV === "production") {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("enter a full web address, starting with https://"); }
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !production)) throw new Error("the address must start with https://");
  if (u.username || u.password) throw new Error("the address must not contain a username or password");
  const v4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host);
  const v6 = /^\[(::1|::|f[cd][0-9a-f:]*|fe80[0-9a-f:]*)\]?$/.test(host); // only bracketed IPv6 literals: a hostname like fcbarcelona.com is fine
  const priv = v4 || v6 || host === "localhost" || host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost");
  if (priv && (production || !local)) throw new Error("that address points inside a private network and cannot be used");
  return u.toString();
}

export async function createEndpoint(db: Database, actor: Actor, p: { url: string; events?: string[] }) {
  assertCan(actor, "integrations.manage");
  if (!actor.businessId) throw new Error("no company linked to this account");
  const url = checkUrl(p.url);
  const events = (p.events ?? []).filter((e): e is EventType => (EVENT_TYPES as readonly string[]).includes(e) && e !== "ping");
  const secret = "whsec_" + randomBytes(24).toString("base64url");
  const [row] = await db.insert(webhookEndpoints).values({ businessId: actor.businessId, url, secret, events, createdBy: actor.id }).returning();
  await db.insert(auditLog).values({ actorId: actor.id, action: "webhook.created", entity: "business", entityId: actor.businessId, after: { endpointId: row.id, url } });
  return { id: row.id, secret }; // shown once
}

export async function setEndpointActive(db: Database, actor: Actor, id: string, active: boolean) {
  assertCan(actor, "integrations.manage");
  const [r] = await db.update(webhookEndpoints).set({ active }).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.businessId, actor.businessId ?? ""))).returning();
  if (!r) throw new Error("endpoint not found");
  await db.insert(auditLog).values({ actorId: actor.id, action: active ? "webhook.enabled" : "webhook.disabled", entity: "business", entityId: r.businessId, after: { endpointId: id } });
}

export const listEndpoints = (db: Database, businessId: string) =>
  db.select({ id: webhookEndpoints.id, url: webhookEndpoints.url, events: webhookEndpoints.events, active: webhookEndpoints.active, createdAt: webhookEndpoints.createdAt })
    .from(webhookEndpoints).where(eq(webhookEndpoints.businessId, businessId)).orderBy(desc(webhookEndpoints.createdAt));

export const recentDeliveries = (db: Database, businessId: string, limit = 25) =>
  db.select({ d: webhookDeliveries, url: webhookEndpoints.url }).from(webhookDeliveries).innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.businessId, businessId)).orderBy(desc(webhookDeliveries.createdAt)).limit(limit);

/**
 * Queue an event for every active endpoint of the company that wants it. Never throws: a webhook problem must not undo
 * the payout, repayment or confirmation that produced the event.
 */
export async function emitEvent(db: Database, businessId: string, type: EventType, data: Record<string, unknown>, now = new Date()) {
  try {
    const eps = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.businessId, businessId), eq(webhookEndpoints.active, true)));
    const mine = eps.filter((e) => e.events.length === 0 || e.events.includes(type) || type === "ping");
    if (!mine.length) return 0;
    const eventId = randomUUID();
    await db.insert(webhookDeliveries).values(mine.map((e) => ({ endpointId: e.id, businessId, type, payload: { id: eventId, type, createdAt: now.toISOString(), data }, nextAttemptAt: now })));
    return mine.length;
  } catch (e) {
    console.error("[webhook] could not queue", type, (e as Error).message);
    return 0;
  }
}

export const sign = (secret: string, body: string, t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

/** Worker: send everything that is due. Success is any 2xx; anything else is retried with backoff, then marked failed. */
export async function deliverWebhooks(db: Database, now = new Date(), send: typeof fetch = fetch) {
  const due = await db.select({ d: webhookDeliveries, e: webhookEndpoints }).from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now))).limit(50);
  const out = { delivered: 0, retrying: 0, failed: 0 };
  for (const { d, e } of due) {
    // Claim it so two workers never send the same delivery.
    const [claim] = await db.update(webhookDeliveries).set({ nextAttemptAt: new Date(now.getTime() + 120_000) })
      .where(and(eq(webhookDeliveries.id, d.id), eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now))).returning({ id: webhookDeliveries.id });
    if (!claim) continue;
    const body = JSON.stringify(d.payload);
    let code: number | null = null, error: string | null = null;
    try {
      checkUrl(e.url); // re-checked at send time, in case rules tightened since the endpoint was saved
      const res = await send(e.url, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "user-agent": "Marichi-Webhooks/1", "x-marichi-event": d.type, "x-marichi-delivery": d.id, "x-marichi-signature": sign(e.secret, body, Math.floor(now.getTime() / 1000)) },
        body,
      });
      code = res.status;
      if (!(res.status >= 200 && res.status < 300)) error = `the endpoint answered ${res.status}`;
    } catch (err) { error = (err as Error).message; }

    if (!error) {
      await db.update(webhookDeliveries).set({ status: "delivered", attempts: d.attempts + 1, deliveredAt: now, lastStatusCode: code, lastError: null }).where(eq(webhookDeliveries.id, d.id));
      out.delivered++;
    } else if (d.attempts + 1 >= MAX_ATTEMPTS) {
      await db.update(webhookDeliveries).set({ status: "failed", attempts: d.attempts + 1, lastStatusCode: code, lastError: error }).where(eq(webhookDeliveries.id, d.id));
      out.failed++;
    } else {
      await db.update(webhookDeliveries).set({ attempts: d.attempts + 1, nextAttemptAt: new Date(now.getTime() + BACKOFF_MIN[d.attempts] * 60_000), lastStatusCode: code, lastError: error }).where(eq(webhookDeliveries.id, d.id));
      out.retrying++;
    }
  }
  return out;
}

/** Queue a test event for one endpoint so the receiver can check its signature handling. */
export async function sendTest(db: Database, actor: Actor, endpointId: string, now = new Date()) {
  assertCan(actor, "integrations.manage");
  const [e] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.businessId, actor.businessId ?? "")));
  if (!e) throw new Error("endpoint not found");
  await db.insert(webhookDeliveries).values({ endpointId: e.id, businessId: e.businessId, type: "ping", payload: { id: randomUUID(), type: "ping", createdAt: now.toISOString(), data: { message: "Test event from Marichi" } }, nextAttemptAt: now });
}

export const pendingDeliveries = async (db: Database, ids?: string[]) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(webhookDeliveries).where(ids ? and(eq(webhookDeliveries.status, "pending"), inArray(webhookDeliveries.endpointId, ids)) : eq(webhookDeliveries.status, "pending")))[0].n;
