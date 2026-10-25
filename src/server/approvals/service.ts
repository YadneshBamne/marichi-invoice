// Maker-checker for company money. A Maker prepares a commitment; an Approver (or the Owner) decides it; nobody decides their own.
// An Approver or Owner commits directly, unless the company turned on dual control or the amount is above the platform line,
// in which case their own request also waits for a DIFFERENT approver.
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, memberships, pendingActions, users } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyUser } from "../notify";
import { acceptOffer, acceptOffers } from "../offers/service";
import { acceptBid, acceptBids, placeBid } from "../marketplace/service";
import { acceptBundle, placeBundleBid } from "../marketplace/bundles";
import { proposeEarlyPayment } from "../earlypay/service";
import { assertCan, can, ForbiddenError, type Permission } from "../permissions";
import { acknowledgeKeyFacts } from "../agreements/keyfacts";

export const APPROVAL = {
  alwaysAbove: 10_00_000_00n, // a commitment this large needs a second person whatever the company's setting
  expiryHours: 48, // a request nobody decides lapses
};

export type Actor = { id: string; role: string; orgRole: string; businessId: string | null };
type Who = { id: string; role: string; businessId: string | null };
const who = (a: Actor): Who => ({ id: a.id, role: a.role, businessId: a.businessId });

type Payloads = {
  "offer.accept": { offerId: string; ack?: boolean };
  "offer.accept_many": { offerIds: string[]; ack?: boolean };
  "bid.accept": { bidId: string; ack?: boolean };
  "bid.accept_group": { bidIds: string[]; ack?: boolean };
  "bundle.bid": { bundleId: string; advanceBps: number; discountBps: number };
  "bundle.accept": { bundleId: string; financierId: string; ack?: boolean };
  "bid.place": { invoiceId: string; advanceBps: number; discountBps: number; shareBps?: number };
  "earlypay.propose": { invoiceId: string; discountBps: number };
};
export type Kind = keyof Payloads;

const mustAck = (ack?: boolean) => { if (!ack) throw new Error("read the key facts for the offer and tick the box to confirm before accepting"); };

/** What each kind of request needs to run, and who may prepare it or commit it directly. */
const HANDLERS: { [K in Kind]: { commit: Permission; prepare: Permission; run: (db: Database, p: Payloads[K], a: Actor, gw: Adapters, now: Date) => Promise<unknown> } } = {
  "offer.accept": { commit: "offer.answer", prepare: "offer.prepare", run: async (db, p, a, _gw, now) => {
    mustAck(p.ack);
    const id = await acceptOffer(db, p.offerId, who(a), now);
    await acknowledgeKeyFacts(db, p.offerId, a.id, now); // the person who commits is the person who read the sheet
    return id;
  } },
  "offer.accept_many": { commit: "offer.answer", prepare: "offer.prepare", run: async (db, p, a, _gw, now) => {
    mustAck(p.ack);
    const r = await acceptOffers(db, p.offerIds, who(a), now);
    for (const x of r) if (x.ok) await acknowledgeKeyFacts(db, x.offerId, a.id, now);
    return r;
  } },
  "bid.accept": { commit: "offer.answer", prepare: "offer.prepare", run: async (db, p, a, gw, now) => {
    mustAck(p.ack);
    const offer = await acceptBid(db, p.bidId, who(a), gw, now);
    await acknowledgeKeyFacts(db, offer.id, a.id, now);
    return offer;
  } },
  "bid.accept_group": { commit: "offer.answer", prepare: "offer.prepare", run: async (db, p, a, gw, now) => {
    mustAck(p.ack);
    const offer = await acceptBids(db, p.bidIds, who(a), gw, now);
    await acknowledgeKeyFacts(db, offer.id, a.id, now);
    return offer;
  } },
  "bundle.bid": { commit: "bid.place", prepare: "bid.prepare", run: (db, p, a, gw, now) => placeBundleBid(db, who(a), p, gw, now) },
  "bundle.accept": { commit: "offer.answer", prepare: "offer.prepare", run: async (db, p, a, gw, now) => {
    mustAck(p.ack);
    const offers = await acceptBundle(db, p.bundleId, p.financierId, who(a), gw, now);
    for (const o of offers) await acknowledgeKeyFacts(db, o.id, a.id, now);
    return offers;
  } },
  "bid.place": { commit: "bid.place", prepare: "bid.prepare", run: (db, p, a, gw, now) => placeBid(db, who(a), p, gw, now) },
  "earlypay.propose": { commit: "earlypay.propose", prepare: "earlypay.prepare", run: (db, p, a, gw, now) => proposeEarlyPayment(db, who(a), p, gw, now) },
};

/** Everyone in the company who may decide a request, other than `except`. */
async function approversOf(db: Database, businessId: string, except: string) {
  const rows = await db.select({ id: users.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.businessId, businessId), inArray(memberships.orgRole, ["owner", "approver"]), isNull(memberships.suspendedAt), isNull(users.suspendedAt)));
  return rows.map((r) => r.id).filter((id) => id !== except);
}

export type Submitted = { status: "done"; result: unknown } | { status: "queued"; id: string };

/**
 * The single entry point for committing company money. Runs now when the actor may commit and no second person is required;
 * otherwise records a request for a different approver to decide.
 */
export async function submit<K extends Kind>(
  db: Database, actor: Actor, kind: K, payload: Payloads[K], ctx: { summary: string; amount: bigint }, gw: Adapters = gateway, now = new Date(),
): Promise<Submitted> {
  if (!actor.businessId) throw new Error("no company linked to this account");
  const h = HANDLERS[kind];
  const canCommit = can(actor, h.commit);
  if (!canCommit && !can(actor, h.prepare)) throw new ForbiddenError(h.commit);
  const [biz] = await db.select({ dual: businesses.dualControl }).from(businesses).where(eq(businesses.id, actor.businessId));
  const needsSecond = !canCommit || biz.dual || ctx.amount >= APPROVAL.alwaysAbove;
  if (!needsSecond) {
    const result = await (h.run as (db: Database, p: Payloads[K], a: Actor, gw: Adapters, now: Date) => Promise<unknown>)(db, payload, actor, gw, now);
    return { status: "done", result };
  }
  const approvers = await approversOf(db, actor.businessId, actor.id);
  if (approvers.length === 0) throw new Error("This needs a second approver and nobody else in your company can approve. Ask your owner to add an approver under Team.");
  const [row] = await db.insert(pendingActions).values({
    businessId: actor.businessId, kind, payload, summary: ctx.summary, amount: ctx.amount, requestedBy: actor.id, expiresAt: new Date(now.getTime() + APPROVAL.expiryHours * 3_600_000),
  }).returning();
  await db.insert(auditLog).values({ actorId: actor.id, action: "approval.requested", entity: "business", entityId: actor.businessId, after: { id: row.id, kind, amount: ctx.amount.toString() } });
  const [me] = await db.select({ n: users.name }).from(users).where(eq(users.id, actor.id));
  for (const id of approvers) await notifyUser(db, id, "approval_requested", { summary: ctx.summary, by: me?.n ?? "A colleague", link: "/approvals" }, gw, now);
  return { status: "queued", id: row.id };
}

/** Approve or reject someone else's request. Approving runs it, as the approver. */
export async function decide(db: Database, actor: Actor, id: string, decision: "approve" | "reject", note = "", gw: Adapters = gateway, now = new Date()) {
  assertCan(actor, "approval.decide");
  if (!actor.businessId) throw new Error("no company linked to this account");
  const [row] = await db.select().from(pendingActions).where(and(eq(pendingActions.id, id), eq(pendingActions.businessId, actor.businessId)));
  if (!row) throw new Error("request not found");
  if (row.status !== "pending") throw new Error(`that request is already ${row.status}`);
  if (row.expiresAt <= now) {
    await db.update(pendingActions).set({ status: "expired" }).where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending")));
    throw new Error("that request has expired. Ask for it to be sent again");
  }
  if (row.requestedBy === actor.id) throw new Error("you cannot decide your own request. A different approver has to");
  const tell = (outcome: string, extra = "") => notifyUser(db, row.requestedBy, "approval_decided", { summary: row.summary, outcome, note: extra }, gw, now);

  if (decision === "reject") {
    const [r] = await db.update(pendingActions).set({ status: "rejected", decidedBy: actor.id, decidedAt: now, note: note.trim() || null }).where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending"))).returning();
    if (!r) throw new Error("that request was just decided by someone else");
    await db.insert(auditLog).values({ actorId: actor.id, action: "approval.rejected", entity: "business", entityId: row.businessId, after: { id, kind: row.kind, note } });
    await tell("rejected", note.trim());
    return { status: "rejected" as const };
  }

  // Claim first, so two approvers pressing the button together cannot run it twice.
  const [claimed] = await db.update(pendingActions).set({ status: "approved", decidedBy: actor.id, decidedAt: now, note: note.trim() || null })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending"))).returning();
  if (!claimed) throw new Error("that request was just decided by someone else");
  try {
    await (HANDLERS[row.kind as Kind].run as (db: Database, p: unknown, a: Actor, gw: Adapters, now: Date) => Promise<unknown>)(db, row.payload, actor, gw, now);
  } catch (e) {
    const why = e instanceof Error ? e.message : "it could not be completed";
    await db.update(pendingActions).set({ status: "failed", note: why }).where(eq(pendingActions.id, id));
    await db.insert(auditLog).values({ actorId: actor.id, action: "approval.failed", entity: "business", entityId: row.businessId, after: { id, kind: row.kind, error: why } });
    await tell("approved but could not be completed", why);
    return { status: "failed" as const, error: why };
  }
  await db.insert(auditLog).values({ actorId: actor.id, action: "approval.approved", entity: "business", entityId: row.businessId, after: { id, kind: row.kind, requestedBy: row.requestedBy } });
  await tell("approved", note.trim());
  return { status: "approved" as const };
}

/** The requester takes their own request back. */
export async function cancel(db: Database, actor: Actor, id: string) {
  const [r] = await db.update(pendingActions).set({ status: "cancelled" })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.requestedBy, actor.id), eq(pendingActions.status, "pending"))).returning();
  if (!r) throw new Error("only your own waiting request can be cancelled");
}

export async function expireStale(db: Database, now = new Date()) {
  const r = await db.update(pendingActions).set({ status: "expired" }).where(and(eq(pendingActions.status, "pending"), lte(pendingActions.expiresAt, now))).returning({ id: pendingActions.id });
  return r.length;
}

/** Requests for the company, newest first, with who asked. Lapsed ones are closed first so nobody approves a stale request. */
export async function listRequests(db: Database, businessId: string, now = new Date()) {
  await db.update(pendingActions).set({ status: "expired" }).where(and(eq(pendingActions.businessId, businessId), eq(pendingActions.status, "pending"), lte(pendingActions.expiresAt, now)));
  return db.select({ r: pendingActions, by: users.name }).from(pendingActions).innerJoin(users, eq(users.id, pendingActions.requestedBy))
    .where(eq(pendingActions.businessId, businessId)).orderBy(desc(pendingActions.createdAt)).limit(100);
}

export async function waitingCount(db: Database, businessId: string, exceptRequester?: string, now = new Date()) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(pendingActions)
    .where(and(eq(pendingActions.businessId, businessId), eq(pendingActions.status, "pending"), sql`${pendingActions.expiresAt} > ${now}`, exceptRequester ? sql`${pendingActions.requestedBy} <> ${exceptRequester}` : undefined));
  return r.n;
}
