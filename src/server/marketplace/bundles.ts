// Bundles: a seller groups several of its invoices on the SAME buyer, so a financier can fund them in one decision. The seller sees one
// choice instead of many, the financier one bid, and everything is decided together or not at all. Underneath, each invoice is still
// financed, signed, paid out and collected on its own, so recourse, the ledger and the collection accounts work exactly as before.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, bids, bundles, financingOffers, invoices, underwritingDecisions } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness } from "../notify";
import { assertCan } from "../permissions";
import { ensureKeyFacts } from "../agreements/keyfacts";
import { formatMoney } from "../../lib/money";
import { acceptBidTx, placeBidTx, position, type FinancierActor, type SellerActor } from "./service";

export type BundleActor = SellerActor & { orgRole?: string | null };
export const BUNDLE_MAX = 20;

export async function createBundle(db: Database, actor: BundleActor, invoiceIds: string[], now = new Date()) {
  assertCan(actor, "invoice.upload");
  const ids = [...new Set(invoiceIds)];
  if (ids.length < 2) throw new Error("choose two or more invoices to bundle");
  if (ids.length > BUNDLE_MAX) throw new Error(`a bundle can hold at most ${BUNDLE_MAX} invoices`);
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(invoices).where(inArray(invoices.id, ids)).for("update");
    if (rows.length !== ids.length) throw new Error("invoice not found");
    if (actor.role !== "seller" || rows.some((r) => r.sellerId !== actor.businessId)) throw new Error("FORBIDDEN");
    if (new Set(rows.map((r) => r.buyerId)).size !== 1) throw new Error("a bundle holds invoices on one buyer only");
    for (const r of rows) {
      if (r.status !== "eligible" || r.disputeFlag) throw new Error(`invoice ${r.invoiceNumber} is not ready for financing`);
      if (r.bundleId) throw new Error(`invoice ${r.invoiceNumber} is already in a bundle`);
    }
    const approved = await tx.select({ id: underwritingDecisions.invoiceId }).from(underwritingDecisions).where(and(inArray(underwritingDecisions.invoiceId, ids), eq(underwritingDecisions.decision, "approved")));
    if (approved.length !== ids.length) throw new Error("every invoice in a bundle must be approved first");
    const funded = await tx.select({ id: financingOffers.id }).from(financingOffers).where(and(inArray(financingOffers.invoiceId, ids), eq(financingOffers.status, "accepted")));
    if (funded.length) throw new Error("one of these invoices has already been funded");
    const [b] = await tx.insert(bundles).values({ sellerId: actor.businessId!, buyerId: rows[0].buyerId, createdAt: now }).returning();
    await tx.update(invoices).set({ bundleId: b.id }).where(inArray(invoices.id, ids));
    await tx.insert(auditLog).values({ actorId: actor.id, action: "bundle.create", entity: "business", entityId: actor.businessId!, after: { bundleId: b.id, invoices: ids.length } });
    return b;
  });
}

/** Take a bundle apart. Not possible once any of its invoices has been funded. */
export async function dissolveBundle(db: Database, actor: BundleActor, bundleId: string, now = new Date()) {
  assertCan(actor, "invoice.upload");
  await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bundles).where(eq(bundles.id, bundleId)).for("update");
    if (!b || b.dissolvedAt) throw new Error("that bundle no longer exists");
    if (actor.role !== "seller" || actor.businessId !== b.sellerId) throw new Error("FORBIDDEN");
    const members = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.bundleId, b.id));
    const funded = members.length ? await tx.select({ id: financingOffers.id }).from(financingOffers).where(and(inArray(financingOffers.invoiceId, members.map((m) => m.id)), eq(financingOffers.status, "accepted"))) : [];
    if (funded.length) throw new Error("part of this bundle has been funded, so it cannot be taken apart");
    await tx.update(invoices).set({ bundleId: null }).where(eq(invoices.bundleId, b.id));
    await tx.update(bundles).set({ dissolvedAt: now }).where(eq(bundles.id, b.id));
    if (members.length) await tx.update(bids).set({ status: "withdrawn", decidedAt: now }).where(and(inArray(bids.invoiceId, members.map((m) => m.id)), eq(bids.status, "open"))); // bids on a bundle make no sense once it is gone
    await tx.insert(auditLog).values({ actorId: actor.id, action: "bundle.dissolve", entity: "business", entityId: b.sellerId, after: { bundleId: b.id } });
  });
}

/** The invoices of a live bundle, soonest due first. */
export const membersOf = (db: Database, bundleId: string) => db.select().from(invoices).where(eq(invoices.bundleId, bundleId)).orderBy(invoices.dueDate);

/** One bid on the whole bundle: the same terms on every invoice, with enough funds for all of them, or nothing is placed. */
export async function placeBundleBid(db: Database, actor: FinancierActor, p: { bundleId: string; advanceBps: number; discountBps: number }, gw: Adapters = gateway, now = new Date()) {
  if (actor.role !== "financier" || !actor.businessId) throw new Error("FORBIDDEN");
  const out = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bundles).where(and(eq(bundles.id, p.bundleId), isNull(bundles.dissolvedAt)));
    if (!b) throw new Error("that bundle is no longer open");
    const members = await tx.select({ id: invoices.id, no: invoices.invoiceNumber }).from(invoices).where(eq(invoices.bundleId, b.id));
    const placed = [];
    for (const m of members) {
      try { placed.push((await placeBidTx(tx, actor, { invoiceId: m.id, advanceBps: p.advanceBps, discountBps: p.discountBps }, now)).bid); }
      catch (e) { throw new Error(`invoice ${m.no}: ${(e as Error).message}`); }
    }
    const total = placed.reduce((a, x) => a + x.advanceAmount, 0n);
    if ((await position(tx, actor.businessId!)).available < total) throw new Error("you do not have enough available funds for the whole bundle");
    return { b, placed, total };
  });
  await notifyBusiness(db, out.b.sellerId, "bid_received", { invoiceNumber: `bundle of ${out.placed.length} invoices`, advance: formatMoney(out.total) }, gw);
  return out.placed;
}

/** Financiers that have an open, unexpired bid on EVERY invoice of the bundle, with what they would advance in total. */
export async function bundleBids(db: Database, bundleId: string, now = new Date()) {
  const members = await membersOf(db, bundleId);
  if (!members.length) return [];
  const open = (await db.select().from(bids).where(and(inArray(bids.invoiceId, members.map((m) => m.id)), eq(bids.status, "open")))).filter((b) => b.expiresAt > now && b.shareBps === 10_000);
  const byFin = new Map<string, typeof open>();
  for (const b of open) byFin.set(b.financierId, [...(byFin.get(b.financierId) ?? []), b]);
  return [...byFin.entries()].filter(([, list]) => members.every((m) => list.some((b) => b.invoiceId === m.id)))
    .map(([financierId, list]) => ({
      financierId, bids: list, advance: list.reduce((a, b) => a + b.advanceAmount, 0n), fee: list.reduce((a, b) => a + b.feeAmount, 0n),
      discountBps: Number(list.reduce((a, b) => a + BigInt(b.discountBps) * b.advanceAmount, 0n) / list.reduce((a, b) => a + b.advanceAmount, 0n)),
    })).sort((a, b) => a.discountBps - b.discountBps);
}

/** The seller takes one financier's bids on the whole bundle. All invoices are accepted together; if any one cannot be, none is. */
export async function acceptBundle(db: Database, bundleId: string, financierId: string, actor: SellerActor, gw: Adapters = gateway, now = new Date()) {
  const out = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bundles).where(and(eq(bundles.id, bundleId), isNull(bundles.dissolvedAt)));
    if (!b) throw new Error("that bundle is no longer open");
    if (actor.role !== "seller" || actor.businessId !== b.sellerId) throw new Error("FORBIDDEN");
    const members = await tx.select({ id: invoices.id, no: invoices.invoiceNumber }).from(invoices).where(eq(invoices.bundleId, b.id));
    const mine = await tx.select().from(bids).where(and(inArray(bids.invoiceId, members.map((m) => m.id)), eq(bids.financierId, financierId), eq(bids.status, "open")));
    const offers = [];
    for (const m of members) {
      const bid = mine.find((x) => x.invoiceId === m.id);
      if (!bid) throw new Error(`that financier has no open bid on invoice ${m.no}`);
      const r = await acceptBidTx(tx, bid.id, actor, now, true);
      if (!r) throw new Error(`the bid on invoice ${m.no} has expired`);
      offers.push(r);
    }
    return { offers, b };
  });
  for (const o of out.offers) await ensureKeyFacts(db, o.offer.id, now).catch((e) => console.error("[keyfacts]", (e as Error).message));
  await notifyBusiness(db, financierId, "bid_accepted", { invoiceNumber: `bundle of ${out.offers.length} invoices`, advance: formatMoney(out.offers.reduce((a, o) => a + o.offer.advanceAmount, 0n)) }, gw);
  return out.offers.map((o) => o.offer);
}
