import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bids, financingOffers, invoices, notifications } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { acceptOffer } from "../offers/service";
import { acceptBid, placeBid } from "./service";
import { acceptBundle, bundleBids, createBundle, dissolveBundle, placeBundleBid } from "./bundles";

let w: Awaited<ReturnType<typeof world>>;
const L = 1_00_000_00n;
beforeEach(async () => { w = await world(); });

/** Two approved invoices on the same buyer, bundled by the seller. */
async function bundled() {
  const a = await w.offered(), b = await w.offered(5n * L);
  const bundle = await createBundle(w.db, w.sellerActor, [a.invoiceId, b.invoiceId], T0);
  return { a, b, bundle };
}

describe("creating a bundle", () => {
  it("groups approved invoices of one buyer, and each remembers its bundle", async () => {
    const { a, b, bundle } = await bundled();
    const rows = await w.db.select().from(invoices).where(eq(invoices.bundleId, bundle.id));
    expect(rows.map((r) => r.id).sort()).toEqual([a.invoiceId, b.invoiceId].sort());
  });

  it("needs two or more, one seller's own, not already bundled, and not already funded", async () => {
    const a = await w.offered(), b = await w.offered();
    await expect(createBundle(w.db, w.sellerActor, [a.invoiceId], T0)).rejects.toThrow(/two or more/);
    await expect(createBundle(w.db, { ...w.sellerActor, businessId: w.buyerId }, [a.invoiceId, b.invoiceId], T0)).rejects.toThrow(/FORBIDDEN/);
    await createBundle(w.db, w.sellerActor, [a.invoiceId, b.invoiceId], T0);
    const c = await w.offered();
    await expect(createBundle(w.db, w.sellerActor, [a.invoiceId, c.invoiceId], T0)).rejects.toThrow(/already in a bundle/);
    await w.db.update(invoices).set({ disputeFlag: true }).where(eq(invoices.id, c.invoiceId));
    const d = await w.offered();
    await expect(createBundle(w.db, w.sellerActor, [c.invoiceId, d.invoiceId], T0)).rejects.toThrow(/not ready for financing/);
  });
});

describe("bidding and accepting as one", () => {
  it("one bid puts the same terms on every invoice, and the seller sees a financier only when it bid on all", async () => {
    const { a, b, bundle } = await bundled();
    const f = await w.financier("Alpha", 50n * L);
    const placed = await placeBundleBid(w.db, f.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    expect(placed).toHaveLength(2);
    const seen = await bundleBids(w.db, bundle.id, T0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ financierId: f.id, advance: 13n * L + L / 2n, discountBps: 1000 });
    // a financier that bid on only one invoice is not offered for the bundle
    const g = await w.financier("Gamma", 50n * L);
    await placeBid(w.db, g.actor, { invoiceId: a.invoiceId, advanceBps: 9000, discountBps: 800 }, gw, T0);
    expect((await bundleBids(w.db, bundle.id, T0)).map((x) => x.financierId)).toEqual([f.id]);
    void b;
  });

  it("is refused entirely when the financier cannot fund all of it", async () => {
    const { a, bundle } = await bundled();
    const f = await w.financier("Small", 10n * L); // enough for the 10 lakh invoice's advance, not for both
    await expect(placeBundleBid(w.db, f.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1000 }, gw, T0)).rejects.toThrow();
    expect(await w.db.select().from(bids)).toHaveLength(0);
    void a;
  });

  it("accepting takes every invoice at once, and the other bids lose out invoice by invoice", async () => {
    const { a, b, bundle } = await bundled();
    const f = await w.financier("Alpha", 50n * L), g = await w.financier("Gamma", 50n * L);
    await placeBundleBid(w.db, f.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    await placeBundleBid(w.db, g.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1200 }, gw, T0);
    const offers = await acceptBundle(w.db, bundle.id, f.id, w.sellerActor, gw, T0);
    expect(offers.map((o) => o.invoiceId).sort()).toEqual([a.invoiceId, b.invoiceId].sort());
    expect(offers.every((o) => o.status === "accepted" && o.financierId === f.id)).toBe(true);
    const gBids = (await w.db.select().from(bids)).filter((x) => x.financierId === g.id);
    expect(gBids.every((x) => x.status !== "open")).toBe(true);
    expect((await w.db.select().from(notifications)).filter((n) => n.template === "bid_accepted")).toHaveLength(1);
    await expect(acceptBundle(w.db, bundle.id, g.id, w.sellerActor, gw, T0)).rejects.toThrow();
  });

  it("accepts nothing when one of the financier's bids is missing or has run out", async () => {
    const { a, b, bundle } = await bundled();
    const f = await w.financier("Alpha", 50n * L);
    await placeBundleBid(w.db, f.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    await w.db.update(bids).set({ expiresAt: new Date(T0.getTime() - 1000) }).where(eq(bids.invoiceId, b.invoiceId));
    await expect(acceptBundle(w.db, bundle.id, f.id, w.sellerActor, gw, T0)).rejects.toThrow(/expired/);
    expect(await w.db.select().from(financingOffers).where(eq(financingOffers.status, "accepted"))).toHaveLength(0); // all or nothing
    void a;
  });

  it("only the seller can accept", async () => {
    const { bundle } = await bundled();
    const f = await w.financier("Alpha", 50n * L);
    await placeBundleBid(w.db, f.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    await expect(acceptBundle(w.db, bundle.id, f.id, { ...w.sellerActor, role: "buyer", businessId: w.buyerId }, gw, T0)).rejects.toThrow(/FORBIDDEN/);
  });
});

describe("taking a bundle apart", () => {
  it("frees the invoices and withdraws the bids on it", async () => {
    const { a, bundle } = await bundled();
    const f = await w.financier("Alpha", 50n * L);
    await placeBundleBid(w.db, f.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    await dissolveBundle(w.db, w.sellerActor, bundle.id, T0);
    expect((await w.db.select().from(invoices).where(eq(invoices.id, a.invoiceId)))[0].bundleId).toBeNull();
    expect((await w.db.select().from(bids)).every((x) => x.status === "withdrawn")).toBe(true);
    await expect(placeBundleBid(w.db, f.actor, { bundleId: bundle.id, advanceBps: 9000, discountBps: 1000 }, gw, T0)).rejects.toThrow(/no longer open/);
  });

  it("is not possible once any invoice in it has been funded", async () => {
    const { a, bundle } = await bundled();
    await w.db.update(financingOffers).set({ status: "accepted" }).where(eq(financingOffers.id, a.offerId));
    await expect(dissolveBundle(w.db, w.sellerActor, bundle.id, T0)).rejects.toThrow(/funded/);
  });
});

describe("an invoice inside a bundle", () => {
  it("cannot be financed on its own, by bid or by the platform's offer, so the bundle stays whole", async () => {
    const { a, bundle } = await bundled();
    const f = await w.financier("Alpha", 50n * L);
    const bid = await placeBid(w.db, f.actor, { invoiceId: a.invoiceId, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    await expect(acceptBid(w.db, bid.id, w.sellerActor, gw, T0)).rejects.toThrow(/in a bundle/);
    await expect(acceptOffer(w.db, a.offerId, w.sellerActor, T0)).rejects.toThrow(/in a bundle/);
    expect(bundle.id).toBeTruthy();
  });
});
