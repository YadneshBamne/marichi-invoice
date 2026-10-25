import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, financingOffers } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { acceptOffer } from "../offers/service";
import { applyForProgramme, decideProgramme, inviteSuppliers, programmeOf, programmeReport, removeSupplier, respondInvite, SCF, termsFor, utilisation } from "./service";

let w: Awaited<ReturnType<typeof world>>;
const L = 1_00_000_00n;
const ops = { id: "00000000-0000-0000-0000-0000000000a1", role: "ops" };
const buyer = () => ({ id: w.buyerUserId, role: "buyer", businessId: w.buyerId });
const SELLER_GSTIN = "27AAAAA1111A1Z5";
beforeEach(async () => { w = await world(); });

async function activeProgramme(limit = 50n * L) {
  const p = await applyForProgramme(w.db, buyer(), { name: "Big Corp suppliers", limit, acceptTerms: true });
  await decideProgramme(w.db, ops, p.id, { decision: "approve", limit, discountBps: 800, advanceBps: 9500 }, gw, T0);
  return p;
}
const join = async (p: { id: string }) => { await inviteSuppliers(w.db, buyer(), [SELLER_GSTIN], gw); await respondInvite(w.db, w.sellerActor, p.id, true, T0, true); };
const offerOf = async (offerId: string) => (await w.db.select().from(financingOffers).where(eq(financingOffers.id, offerId)))[0];

describe("applying and approval", () => {
  it("only an approved buyer applies, once, and staff set the price", async () => {
    await expect(applyForProgramme(w.db, { ...buyer(), role: "seller" }, { name: "x", limit: L })).rejects.toThrow("FORBIDDEN");
    await expect(applyForProgramme(w.db, buyer(), { name: " ", limit: L })).rejects.toThrow("name");
    await expect(applyForProgramme(w.db, buyer(), { name: "x", limit: SCF.maxLimit + 1n })).rejects.toThrow("limit");
    const p = await applyForProgramme(w.db, buyer(), { name: "Big Corp suppliers", limit: 20n * L, acceptTerms: true });
    expect(p).toMatchObject({ status: "requested", limit: 0n });
    await expect(applyForProgramme(w.db, buyer(), { name: "again", limit: L, acceptTerms: true })).rejects.toThrow("already has");
    await expect(decideProgramme(w.db, { ...ops, role: "seller" }, p.id, { decision: "approve", limit: L, discountBps: 800, advanceBps: 9500 })).rejects.toThrow("forbidden");
    await expect(decideProgramme(w.db, ops, p.id, { decision: "approve", limit: L, discountBps: 100, advanceBps: 9500 })).rejects.toThrow("between");
    await expect(decideProgramme(w.db, ops, p.id, { decision: "approve", limit: L, discountBps: 800, advanceBps: 9900 })).rejects.toThrow("at most");
    await expect(decideProgramme(w.db, ops, p.id, { decision: "approve", discountBps: 800, advanceBps: 9500 })).rejects.toThrow("limit");
    await decideProgramme(w.db, ops, p.id, { decision: "approve", limit: 20n * L, discountBps: 800, advanceBps: 9500 }, gw, T0);
    expect(await programmeOf(w.db, w.buyerId)).toMatchObject({ status: "active", limit: 20n * L, discountBps: 800, advanceBps: 9500 });
  });
  it("an unverified buyer cannot apply; declining needs a reason and frees the buyer to apply again", async () => {
    await w.db.update(businesses).set({ kybStatus: "under_review" }).where(eq(businesses.id, w.buyerId));
    await expect(applyForProgramme(w.db, buyer(), { name: "x", limit: L, acceptTerms: true })).rejects.toThrow("not approved");
    await w.db.update(businesses).set({ kybStatus: "approved" }).where(eq(businesses.id, w.buyerId));
    const p = await applyForProgramme(w.db, buyer(), { name: "x", limit: L, acceptTerms: true });
    await expect(decideProgramme(w.db, ops, p.id, { decision: "decline" })).rejects.toThrow("note");
    await decideProgramme(w.db, ops, p.id, { decision: "decline", note: "thin financials" }, gw, T0);
    await expect(applyForProgramme(w.db, buyer(), { name: "second try", limit: L, acceptTerms: true })).resolves.toMatchObject({ status: "requested" });
  });
});

describe("inviting suppliers", () => {
  it("reports each GSTIN: invited, already, not found, invalid, self; invites need an active programme", async () => {
    await expect(inviteSuppliers(w.db, buyer(), [SELLER_GSTIN], gw)).rejects.toThrow("not active");
    await activeProgramme();
    const r = await inviteSuppliers(w.db, buyer(), [SELLER_GSTIN, "29ZZZZZ9999Z1Z5", "bad", "29BBBBB2222B1Z5", SELLER_GSTIN], gw);
    expect(Object.fromEntries(r.map((x) => [x.gstin, x.result]))).toEqual({ [SELLER_GSTIN]: "invited", "29ZZZZZ9999Z1Z5": "not_found", BAD: "invalid", "29BBBBB2222B1Z5": "self" });
    expect((await inviteSuppliers(w.db, buyer(), [SELLER_GSTIN], gw))[0].result).toBe("already");
  });
  it("the supplier decides: terms apply only once it joins, and not after it is removed or the programme is paused", async () => {
    const p = await activeProgramme();
    await inviteSuppliers(w.db, buyer(), [SELLER_GSTIN], gw);
    expect(await termsFor(w.db, w.buyerId, w.sellerId)).toBeNull(); // invited is not joined
    await expect(respondInvite(w.db, { ...w.sellerActor, businessId: w.buyerId }, p.id, true, T0, true)).rejects.toThrow("no open invitation");
    await respondInvite(w.db, w.sellerActor, p.id, true, T0, true);
    expect(await termsFor(w.db, w.buyerId, w.sellerId)).toMatchObject({ discountBps: 800 });
    await decideProgramme(w.db, ops, p.id, { decision: "pause" }, gw, T0);
    expect(await termsFor(w.db, w.buyerId, w.sellerId)).toBeNull();
    await decideProgramme(w.db, ops, p.id, { decision: "resume" }, gw, T0);
    await removeSupplier(w.db, buyer(), p.id, w.sellerId);
    expect(await termsFor(w.db, w.buyerId, w.sellerId)).toBeNull();
  });
});

describe("pricing and limits", () => {
  it("a joined supplier is priced on the buyer's credit, not its own", async () => {
    const plain = await offerOf((await w.offered()).offerId);
    expect(plain).toMatchObject({ discountBps: 1200 }); // grade A, 780 bureau
    const p = await activeProgramme();
    await join(p);
    const inProgramme = await offerOf((await w.offered()).offerId);
    expect(inProgramme).toMatchObject({ discountBps: 800, advanceAmount: 9_50_000_00n });
    expect(inProgramme.expectedDiscount).toBeLessThan(plain.expectedDiscount);
  });
  it("stops offering once the programme limit is committed", async () => {
    const p = await activeProgramme(10n * L); // room for one ₹9.5L advance
    await join(p);
    const first = await w.offered();
    await acceptOffer(w.db, first.offerId, w.sellerActor, T0);
    expect(await utilisation(w.db, w.buyerId)).toBe(9_50_000_00n);
    await expect(w.offered()).rejects.toThrow("unfunded");
  });
  it("reports suppliers, utilisation, the approved-invoice feed and a payment calendar", async () => {
    const p = await activeProgramme();
    await join(p);
    const a = await w.offered(), b = await w.offered(5n * L);
    await acceptOffer(w.db, a.offerId, w.sellerActor, T0);
    const r = (await programmeReport(w.db, w.buyerId))!;
    expect(r.suppliers).toHaveLength(1);
    expect(r.feed.map((f) => f.i.id).sort()).toEqual([a.invoiceId, b.invoiceId].sort());
    expect(r.used).toBe(9_50_000_00n);
    expect(r.calendar).toEqual([{ date: "2026-11-20", due: 15n * L, count: 2 }]);
  });
});
