import { and, eq, inArray, lte, notExists, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, financingOffers, invoices, underwritingDecisions } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { assertNotFrozen } from "../fraud/service";
import { notifyBusiness } from "../notify";
import { formatINR } from "../../lib/money";
import { OFFER, platformCapital, priceOffer } from "./pricing";

const dayOf = (d: Date | string) => Math.floor(new Date(d).getTime() / 86_400_000);
const LIVE = ["open", "accepted"] as const;
export type SellerActor = { id: string; role: string; businessId: string | null };

/** Flip open offers past their expiry to `expired`. Safe to call any time; the worker also sweeps. */
export async function expireOffers(db: Database, now = new Date()) {
  const r = await db.update(financingOffers).set({ status: "expired" })
    .where(and(eq(financingOffers.status, "open"), lte(financingOffers.expiresAt, now))).returning({ id: financingOffers.id });
  return r.length;
}

/**
 * Create the offer for an approved, eligible invoice. Phase 1: the platform balance sheet is the only financier,
 * so capacity is `platformCapital() - advances still deployed`. Not enough room => `unfunded` (seller is told).
 */
export async function generateOffer(db: Database, invoiceId: string, gw: Adapters = gateway, now = new Date()) {
  await expireOffers(db, now);
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new Error("invoice not found");
  if (inv.status !== "eligible" || inv.disputeFlag) throw new Error(`invoice cannot be offered financing (${inv.status})`);
  await assertNotFrozen(db, invoiceId);
  const [uw] = await db.select().from(underwritingDecisions).where(eq(underwritingDecisions.invoiceId, invoiceId));
  if (uw?.decision !== "approved") throw new Error("invoice is not approved by underwriting");

  const tenorDays = dayOf(inv.dueDate) - dayOf(now);
  if (tenorDays < 1) throw new Error("invoice is due; too late to finance");
  const price = priceOffer({ amount: inv.amount, advanceBps: uw.advanceRateBps, discountBps: uw.discountRateBps, tenorDays });

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7001)`); // serialise capacity checks across concurrent offers
    const [live] = await tx.select().from(financingOffers).where(and(eq(financingOffers.invoiceId, invoiceId), inArray(financingOffers.status, [...LIVE])));
    if (live) return { offer: live, created: false as const };

    const [{ deployed }] = await tx.select({ deployed: sql<string>`coalesce(sum(${financingOffers.advanceAmount}), 0)` })
      .from(financingOffers).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
      .where(and(eq(financingOffers.status, "accepted"), inArray(invoices.status, ["eligible", "financed", "due", "overdue"])));
    if (BigInt(deployed) + price.advanceAmount > platformCapital()) return { unfunded: true as const };

    const [offer] = await tx.insert(financingOffers).values({
      invoiceId, financierId: null, advanceAmount: price.advanceAmount, discountBps: uw.discountRateBps,
      feeAmount: price.feeAmount, tenorDays, expectedDiscount: price.expectedDiscount, recourse: true,
      expiresAt: new Date(now.getTime() + OFFER.validityHours * 3_600_000),
    }).returning();
    await tx.insert(auditLog).values({ action: "offer.create", entity: "invoice", entityId: invoiceId, after: { offerId: offer.id } });
    return { offer, created: true as const };
  });

  if ("unfunded" in result) {
    await notifyBusiness(db, inv.sellerId, "invoice_unfunded", { invoiceNumber: inv.invoiceNumber }, gw);
    return { unfunded: true as const };
  }
  if (result.created) {
    await notifyBusiness(db, inv.sellerId, "offer_ready", {
      invoiceNumber: inv.invoiceNumber, advance: formatINR(result.offer.advanceAmount), expires: result.offer.expiresAt.toISOString(),
    }, gw);
  }
  return { unfunded: false as const, offer: result.offer, price };
}

/** Worker: offer every approved invoice that has never had one (seller-rejected/expired ones are the seller's call). */
export async function generateOffers(db: Database, gw: Adapters = gateway) {
  const rows = await db.select({ id: invoices.id }).from(invoices)
    .innerJoin(underwritingDecisions, eq(underwritingDecisions.invoiceId, invoices.id))
    .where(and(
      eq(invoices.status, "eligible"), eq(invoices.disputeFlag, false), eq(underwritingDecisions.decision, "approved"),
      notExists(db.select({ x: sql`1` }).from(financingOffers).where(eq(financingOffers.invoiceId, invoices.id))),
    ));
  let n = 0;
  for (const r of rows) {
    try { const o = await generateOffer(db, r.id, gw); if (!o.unfunded) n++; } catch (e) { console.error("[offer]", r.id, (e as Error).message); }
  }
  return n;
}

async function respond(db: Database, offerId: string, actor: SellerActor, to: "accepted" | "rejected", now: Date) {
  const out = await db.transaction(async (tx) => {
    const [offer] = await tx.select().from(financingOffers).where(eq(financingOffers.id, offerId)).for("update");
    if (!offer) throw new Error("offer not found");
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, offer.invoiceId));
    if (actor.role !== "seller" || actor.businessId !== inv.sellerId) throw new Error("FORBIDDEN");
    if (offer.status !== "open") throw new Error(`offer is ${offer.status}`);
    if (offer.expiresAt <= now) {
      // Persist the expiry (throwing here would roll it back); the caller throws after commit.
      await tx.update(financingOffers).set({ status: "expired" }).where(eq(financingOffers.id, offer.id));
      return null;
    }
    if (to === "accepted" && (inv.status !== "eligible" || inv.disputeFlag)) throw new Error("invoice is no longer eligible for financing");
    if (to === "accepted") await assertNotFrozen(tx, inv.id);
    await tx.update(financingOffers).set({ status: to, ...(to === "accepted" ? { acceptedAt: now, acceptedBy: actor.id } : {}) })
      .where(eq(financingOffers.id, offer.id));
    await tx.insert(auditLog).values({ actorId: actor.id, action: `offer.${to}`, entity: "invoice", entityId: inv.id, after: { offerId } });
    return offer.id;
  });
  if (!out) throw new Error("offer has expired");
  return out;
}

export const acceptOffer = (db: Database, offerId: string, actor: SellerActor, now = new Date()) => respond(db, offerId, actor, "accepted", now);
export const rejectOffer = (db: Database, offerId: string, actor: SellerActor, now = new Date()) => respond(db, offerId, actor, "rejected", now);
