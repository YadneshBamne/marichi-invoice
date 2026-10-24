import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, financingOffers, memberships, notifications, pendingActions, users } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { setDualControl, type Actor } from "../company/service";
import { APPROVAL, cancel, decide, expireStale, listRequests, submit, waitingCount } from "./service";

let w: Awaited<ReturnType<typeof world>>;
let owner: Actor;
beforeEach(async () => { w = await world(); owner = { id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId }; });

async function person(email: string, orgRole: "admin" | "approver" | "maker" | "viewer"): Promise<Actor> {
  const [u] = await w.db.insert(users).values({ name: email.split("@")[0], email, role: "seller", businessId: w.sellerId, orgRole }).returning();
  await w.db.insert(memberships).values({ userId: u.id, businessId: w.sellerId, orgRole });
  return { id: u.id, role: "seller", orgRole, businessId: w.sellerId };
}
const status = async (offerId: string) => (await w.db.select().from(financingOffers).where(eq(financingOffers.id, offerId)))[0].status;
const ask = (a: Actor, offerId: string, amount = 9_00_000_00n, now = T0) => submit(w.db, a, "offer.accept", { offerId }, { summary: "Accept the offer on invoice INV-1", amount }, gw, now);
const templates = async () => (await w.db.select().from(notifications)).map((n) => n.template);

describe("who commits directly and who must ask", () => {
  it("an owner or approver commits on their own when dual control is off and the amount is below the line", async () => {
    const { offerId } = await w.offered(5_00_000_00n); // advance ₹4.5L
    const r = await ask(owner, offerId, 4_50_000_00n);
    expect(r.status).toBe("done");
    expect(await status(offerId)).toBe("accepted");
    expect(await w.db.select().from(pendingActions)).toHaveLength(0);
  });

  it("a maker's request waits: nothing happens until an approver decides", async () => {
    const maker = await person("maker@seller.com", "maker");
    await person("appr@seller.com", "approver");
    const { offerId } = await w.offered(5_00_000_00n);
    const r = await ask(maker, offerId, 4_50_000_00n);
    expect(r.status).toBe("queued");
    expect(await status(offerId)).toBe("open");
    expect(await templates()).toContain("approval_requested"); // the approvers are told
    expect(await waitingCount(w.db, w.sellerId, maker.id, T0)).toBe(0); // nothing for the maker to decide: it is their own
    expect(await waitingCount(w.db, w.sellerId, owner.id, T0)).toBe(1);
  });

  it("a viewer or admin cannot even ask", async () => {
    const { offerId } = await w.offered(5_00_000_00n);
    for (const r of ["viewer", "admin"] as const) await expect(ask(await person(`${r}@seller.com`, r), offerId)).rejects.toThrow(/not allowed/);
  });

  it("dual control makes even the owner's own commitment wait for a different approver", async () => {
    await setDualControl(w.db, owner, true);
    const { offerId } = await w.offered(5_00_000_00n);
    await expect(ask(owner, offerId, 4_50_000_00n)).rejects.toThrow(/second approver/); // nobody else can approve yet
    await person("appr@seller.com", "approver");
    const r = await ask(owner, offerId, 4_50_000_00n);
    expect(r.status).toBe("queued");
    expect(await status(offerId)).toBe("open");
  });

  it("a large commitment always needs a second person, whatever the company setting", async () => {
    const { offerId } = await w.offered(); // ₹9L advance; push the declared amount over the line
    await expect(ask(owner, offerId, APPROVAL.alwaysAbove)).rejects.toThrow(/second approver/);
    await person("appr@seller.com", "approver");
    expect((await ask(owner, offerId, APPROVAL.alwaysAbove)).status).toBe("queued");
  });
});

describe("deciding", () => {
  async function queued(amount = 4_50_000_00n) {
    const maker = await person("maker@seller.com", "maker");
    const appr = await person("appr@seller.com", "approver");
    const { offerId } = await w.offered(5_00_000_00n);
    const r = await ask(maker, offerId, amount);
    if (r.status !== "queued") throw new Error("expected queued");
    return { maker, appr, offerId, id: r.id };
  }

  it("an approver approves: it runs as the approver, is audited, and the maker is told", async () => {
    const { appr, offerId, id, maker } = await queued();
    expect(await decide(w.db, appr, id, "approve", "looks right", gw, T0)).toEqual({ status: "approved" });
    expect(await status(offerId)).toBe("accepted");
    const [row] = await w.db.select().from(pendingActions);
    expect(row).toMatchObject({ status: "approved", decidedBy: appr.id, requestedBy: maker.id, note: "looks right" });
    expect((await w.db.select().from(financingOffers).where(eq(financingOffers.id, offerId)))[0].acceptedBy).toBe(appr.id);
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "approval.approved"))).length).toBe(1);
    expect(await templates()).toContain("approval_decided");
  });

  it("nobody decides their own request, even with approver power", async () => {
    await setDualControl(w.db, owner, true);
    const second = await person("appr@seller.com", "approver");
    const { offerId } = await w.offered(5_00_000_00n);
    const r = await ask(owner, offerId, 4_50_000_00n);
    if (r.status !== "queued") throw new Error("expected queued");
    await expect(decide(w.db, owner, r.id, "approve", "", gw, T0)).rejects.toThrow(/your own request/);
    await expect(decide(w.db, owner, r.id, "reject", "", gw, T0)).rejects.toThrow(/your own request/);
    expect(await decide(w.db, second, r.id, "approve", "", gw, T0)).toEqual({ status: "approved" });
  });

  it("a maker, admin or viewer cannot decide", async () => {
    const { maker, id } = await queued();
    await expect(decide(w.db, maker, id, "approve")).rejects.toThrow(/not allowed/);
    await expect(decide(w.db, await person("ad@seller.com", "admin"), id, "approve")).rejects.toThrow(/not allowed/);
  });

  it("rejecting leaves the offer untouched and tells the maker why", async () => {
    const { appr, offerId, id } = await queued();
    expect(await decide(w.db, appr, id, "reject", "terms changed", gw, T0)).toEqual({ status: "rejected" });
    expect(await status(offerId)).toBe("open");
    expect((await w.db.select().from(pendingActions))[0]).toMatchObject({ status: "rejected", note: "terms changed" });
    await expect(decide(w.db, appr, id, "approve", "", gw, T0)).rejects.toThrow(/already rejected/);
  });

  it("a request nobody decides lapses; approving it later is refused", async () => {
    const { appr, id } = await queued();
    const late = new Date(T0.getTime() + (APPROVAL.expiryHours + 1) * 3_600_000);
    await expect(decide(w.db, appr, id, "approve", "", gw, late)).rejects.toThrow(/expired/);
    expect((await w.db.select().from(pendingActions))[0].status).toBe("expired");
    expect(await expireStale(w.db, late)).toBe(0);
  });

  it("if the underlying action can no longer happen, the approval records the failure instead of pretending", async () => {
    const { appr, offerId, id } = await queued();
    await w.db.update(financingOffers).set({ status: "expired" }).where(eq(financingOffers.id, offerId)); // the offer lapsed while waiting
    const r = await decide(w.db, appr, id, "approve", "", gw, T0);
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("expired") });
    expect((await w.db.select().from(pendingActions))[0]).toMatchObject({ status: "failed" });
  });

  it("two approvers pressing approve together run it once", async () => {
    const { appr, id } = await queued();
    const second = await person("appr2@seller.com", "approver");
    const results = await Promise.allSettled([decide(w.db, appr, id, "approve", "", gw, T0), decide(w.db, second, id, "approve", "", gw, T0)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "approval.approved"))).toHaveLength(1);
  });

  it("another company cannot see or decide your request", async () => {
    const { id } = await queued();
    await expect(decide(w.db, { id: w.buyerUserId, role: "buyer", orgRole: "owner", businessId: w.buyerId }, id, "approve")).rejects.toThrow(/not found/);
  });

  it("the maker can withdraw their own waiting request, nobody else's", async () => {
    const { maker, appr, id } = await queued();
    await expect(cancel(w.db, appr, id)).rejects.toThrow(/your own/);
    await cancel(w.db, maker, id);
    expect((await w.db.select().from(pendingActions))[0].status).toBe("cancelled");
  });

  it("lists the company's requests with who asked, closing lapsed ones first", async () => {
    await queued();
    const rows = await listRequests(w.db, w.sellerId, T0);
    expect(rows).toHaveLength(1);
    expect(rows[0].by).toBe("maker");
    const later = await listRequests(w.db, w.sellerId, new Date(T0.getTime() + 100 * 3_600_000));
    expect(later[0].r.status).toBe("expired");
  });
});

describe("bulk and bid commitments use the same gate", () => {
  it("accepting several offers at once is one request, executed together on approval", async () => {
    const maker = await person("maker@seller.com", "maker");
    const appr = await person("appr@seller.com", "approver");
    const a = await w.offered(3_00_000_00n), b = await w.offered(3_00_000_00n);
    const r = await submit(w.db, maker, "offer.accept_many", { offerIds: [a.offerId, b.offerId] }, { summary: "Accept 2 offers", amount: 5_40_000_00n }, gw, T0);
    if (r.status !== "queued") throw new Error("expected queued");
    expect(await decide(w.db, appr, r.id, "approve", "", gw, T0)).toEqual({ status: "approved" });
    expect(await status(a.offerId)).toBe("accepted");
    expect(await status(b.offerId)).toBe("accepted");
  });
});
