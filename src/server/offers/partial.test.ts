import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { financingOffers } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { prepareAgreements, signAll } from "../agreements/service";
import { acceptOffers, repriceOffer } from "./service";
import { describeOffer, priceOffer } from "./pricing";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });
const offer = async (id: string) => (await w.db.select().from(financingOffers).where(eq(financingOffers.id, id)))[0];

describe("partial financing", () => {
  it("prices a smaller advance with a proportional fee, and the full advance exactly as before", () => {
    const full = priceOffer({ amount: 10_00_000_00n, advanceBps: 8500, discountBps: 1500, tenorDays: 30 });
    expect(full).toMatchObject({ advanceAmount: 8_50_000_00n, feeAmount: 5_000_00n });
    const half = priceOffer({ amount: 10_00_000_00n, advanceBps: 8500, discountBps: 1500, tenorDays: 30, advanceAmount: 4_25_000_00n });
    expect(half).toMatchObject({ advanceAmount: 4_25_000_00n, feeAmount: 2_500_00n });
    expect(half.expectedDiscount).toBe(full.expectedDiscount / 2n);
    expect(() => priceOffer({ amount: 10_00_000_00n, advanceBps: 8500, discountBps: 1500, tenorDays: 30, advanceAmount: 9_00_000_00n })).toThrow(/no more than the maximum/);
    expect(() => priceOffer({ amount: 10_00_000_00n, advanceBps: 8500, discountBps: 1500, tenorDays: 30, advanceAmount: 5_000_00n })).toThrow(/minimum/);
  });

  it("describeOffer matches priceOffer for any advance", () => {
    const p = priceOffer({ amount: 10_00_000_00n, advanceBps: 8500, discountBps: 1500, tenorDays: 30, advanceAmount: 4_25_000_00n });
    expect(describeOffer({ ...p, tenorDays: 30 })).toMatchObject({ netDisbursal: p.netDisbursal, effectiveAprBps: p.effectiveAprBps });
  });

  it("the seller re-prices an open offer: the old one is rejected, a new smaller one is open", async () => {
    const { offerId } = await w.offered(10_00_000_00n);
    const next = await repriceOffer(w.db, offerId, w.sellerActor, 4_00_000_00n, gw, T0);
    expect(next.advanceAmount).toBe(4_00_000_00n);
    expect(next.status).toBe("open"); expect(next.id).not.toBe(offerId);
    expect((await offer(offerId)).status).toBe("rejected");
  });

  it("only the owning seller can re-price, and only an open offer", async () => {
    const { offerId } = await w.offered(10_00_000_00n);
    await expect(repriceOffer(w.db, offerId, { ...w.sellerActor, businessId: w.buyerId }, 4_00_000_00n, gw, T0)).rejects.toThrow("FORBIDDEN");
    await expect(repriceOffer(w.db, offerId, w.sellerActor, 99_00_00_000n, gw, T0)).rejects.toThrow(/maximum/);
    expect((await offer(offerId)).status).toBe("open"); // a failed re-price leaves the original untouched
  });
});

describe("bulk accept and sign", () => {
  it("accepts several offers in one call and reports each separately", async () => {
    const a = await w.offered(5_00_000_00n), b = await w.offered(6_00_000_00n);
    const bogus = "00000000-0000-4000-8000-000000000000";
    const r = await acceptOffers(w.db, [a.offerId, b.offerId, bogus, a.offerId], w.sellerActor, T0);
    expect(r.map((x) => x.ok)).toEqual([true, true, false]); // duplicates are collapsed
    expect((await offer(a.offerId)).status).toBe("accepted"); expect((await offer(b.offerId)).status).toBe("accepted");
  });

  it("signs the documents of several offers at once", async () => {
    const a = await w.acceptedOffer(5_00_000_00n), b = await w.acceptedOffer(6_00_000_00n);
    await prepareAgreements(w.db, a, gw, T0); await prepareAgreements(w.db, b, gw, T0);
    const r = await signAll(w.db, { offerIds: [a, b], actor: w.sellerActor }, T0);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(r[0].signed).toBeGreaterThanOrEqual(1);
    const wrong = await signAll(w.db, { offerIds: [a], actor: { ...w.sellerActor, businessId: w.buyerId } }, T0);
    expect(wrong[0]).toMatchObject({ ok: false, error: "FORBIDDEN" });
  });
});
