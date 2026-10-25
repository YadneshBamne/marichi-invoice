import { and, eq, inArray, lte, notExists, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, financingOffers, invoices, underwritingDecisions } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { assertNotFrozen } from "../fraud/service";
import { assertNoEarlyPayment } from "../earlypay/service";
import { termsFor, utilisation } from "../scf/service";
import { ensureKeyFacts } from "../agreements/keyfacts";
import { CROSS } from "../crossborder/rules";
import { notifyBusiness } from "../notify";
import { emitEvent } from "../erp/events";
import { formatMoney } from "../../lib/money";
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
export type OfferOptions = {
  /** Finance less than the maximum advance (partial financing). */
  advanceAmount?: bigint;
  /** Replace the offer that is currently open instead of returning it (used when the seller re-prices). */
  replaceOpen?: boolean;
};
export async function generateOffer(db: Database, invoiceId: string, gw: Adapters = gateway, now = new Date(), opts: OfferOptions = {}) {
  await expireOffers(db, now);
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new Error("invoice not found");
  if (inv.status !== "eligible" || inv.disputeFlag) throw new Error(`invoice cannot be offered financing (${inv.status})`);
  await assertNotFrozen(db, invoiceId);
  await assertNoEarlyPayment(db, invoiceId);
  const [uw] = await db.select().from(underwritingDecisions).where(eq(underwritingDecisions.invoiceId, invoiceId));
  if (uw?.decision !== "approved") throw new Error("invoice is not approved by underwriting");
  if (!OFFER.platformFunds) return { unfunded: true as const, awaitingBids: true as const }; // marketplace only: the seller waits for financiers' bids

  const tenorDays = dayOf(inv.dueDate) - dayOf(now);
  if (tenorDays < 1) throw new Error("invoice is due; too late to finance");
  // A buyer's supply chain finance programme prices its suppliers' invoices on the buyer's credit. The supplier's own approval still gates the offer.
  const programme = await termsFor(db, inv.buyerId, inv.sellerId);
  const abroad = inv.currency !== "INR"; // export invoices are advanced less and priced for country and currency risk
  const advanceBps = (programme?.advanceBps ?? uw.advanceRateBps) - (abroad ? CROSS.advanceCutBps : 0);
  const discountBps = (programme?.discountBps ?? uw.discountRateBps) + (abroad ? CROSS.riskPremiumBps : 0);
  const price = priceOffer({ amount: inv.amount, advanceBps, discountBps, tenorDays, advanceAmount: opts.advanceAmount });

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7001)`); // serialise capacity checks across concurrent offers
    const [live] = await tx.select().from(financingOffers).where(and(eq(financingOffers.invoiceId, invoiceId), inArray(financingOffers.status, [...LIVE])));
    if (live && opts.replaceOpen && live.status === "open") {
      await tx.update(financingOffers).set({ status: "rejected" }).where(eq(financingOffers.id, live.id));
      await tx.insert(auditLog).values({ action: "offer.repriced", entity: "invoice", entityId: invoiceId, before: { offerId: live.id, advance: live.advanceAmount.toString() }, after: { advance: price.advanceAmount.toString() } });
    } else if (live) return { offer: live, created: false as const };

    const [{ deployed }] = await tx.select({ deployed: sql<string>`coalesce(sum(${financingOffers.advanceAmount}), 0)` })
      .from(financingOffers).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
      .where(and(eq(financingOffers.status, "accepted"), inArray(invoices.status, ["eligible", "financed", "due", "overdue"])));
    if (BigInt(deployed) + price.advanceAmount > platformCapital()) return { unfunded: true as const };
    if (programme && (await utilisation(tx, inv.buyerId)) + price.advanceAmount > programme.limit) return { unfunded: true as const }; // the buyer's programme limit is full

    const [offer] = await tx.insert(financingOffers).values({
      invoiceId, financierId: null, advanceAmount: price.advanceAmount, discountBps,
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
    await ensureKeyFacts(db, result.offer.id, now).catch((e) => console.error("[keyfacts]", (e as Error).message)); // the seller reads it before accepting
    await notifyBusiness(db, inv.sellerId, "offer_ready", {
      invoiceNumber: inv.invoiceNumber, advance: formatMoney(result.offer.advanceAmount), expires: result.offer.expiresAt.toISOString(),
    }, gw);
    await emitEvent(db, inv.sellerId, "offer.created", {
      invoiceNumber: inv.invoiceNumber, advanceAmountPaise: result.offer.advanceAmount.toString(), feePaise: result.offer.feeAmount.toString(),
      netPayoutPaise: (result.offer.advanceAmount - result.offer.feeAmount).toString(), expiresAt: result.offer.expiresAt.toISOString(),
    }, now);
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
    if (to === "accepted") { await assertNotFrozen(tx, inv.id); await assertNoEarlyPayment(tx, inv.id); }
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

/** The seller finances less than the maximum: the open offer is replaced by a freshly priced one. */
export async function repriceOffer(db: Database, offerId: string, actor: SellerActor, advanceAmount: bigint, gw: Adapters = gateway, now = new Date()) {
  const [offer] = await db.select().from(financingOffers).where(eq(financingOffers.id, offerId));
  if (!offer) throw new Error("offer not found");
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, offer.invoiceId));
  if (actor.role !== "seller" || actor.businessId !== inv.sellerId) throw new Error("FORBIDDEN");
  if (offer.status !== "open") throw new Error(`offer is ${offer.status}`);
  const r = await generateOffer(db, inv.id, gw, now, { advanceAmount, replaceOpen: true });
  if (r.unfunded) throw new Error("there is not enough capital available to re-price this offer right now");
  return r.offer;
}

/** Accept several offers at once. Each is its own commitment: one failing does not stop the others, and each failure is reported. */
export async function acceptOffers(db: Database, offerIds: string[], actor: SellerActor, now = new Date()) {
  const results: { offerId: string; ok: boolean; error?: string }[] = [];
  for (const id of new Set(offerIds)) {
    try { await acceptOffer(db, id, actor, now); results.push({ offerId: id, ok: true }); }
    catch (e) { results.push({ offerId: id, ok: false, error: (e as Error).message }); }
  }
  return results;
}
