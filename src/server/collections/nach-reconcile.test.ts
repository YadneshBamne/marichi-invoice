import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mandates } from "../db/schema";
import { gw, world } from "../testkit";
import { reconcilePendingMandates, registerMandate } from "./nach";

let w: Awaited<ReturnType<typeof world>>;
const bank = { accountNumber: "50100123456789", ifsc: "HDFC0001234", holderName: "Big Corp", maxAmount: 20_00_000_00n };
beforeEach(async () => { w = await world(); });

describe("asking the provider about mandates that are still waiting", () => {
  it("books an authorisation, a refusal and a cancellation, and leaves a still-pending one alone", async () => {
    const buyer = { id: w.buyerUserId, role: "buyer", businessId: w.buyerId };
    const m = await registerMandate(w.db, buyer, bank, gw);
    const ask = (status: "pending" | "active" | "rejected" | "cancelled", reason?: string) => reconcilePendingMandates(w.db, async () => ({ status, reason }), gw);
    expect(await ask("pending")).toEqual({ active: 0, rejected: 0, revoked: 0 });
    expect((await w.db.select().from(mandates).where(eq(mandates.id, m.id)))[0].status).toBe("pending");
    expect(await ask("active")).toEqual({ active: 1, rejected: 0, revoked: 0 });
    expect((await w.db.select().from(mandates).where(eq(mandates.id, m.id)))[0]).toMatchObject({ status: "active", activatedAt: expect.any(Date) });
    expect(await ask("active")).toEqual({ active: 0, rejected: 0, revoked: 0 }); // decided: nothing more to ask

    await w.db.update(mandates).set({ status: "revoked" }).where(eq(mandates.id, m.id));
    const m2 = await registerMandate(w.db, buyer, bank, gw);
    expect(await ask("rejected", "insufficient proof")).toEqual({ active: 0, rejected: 1, revoked: 0 });
    expect((await w.db.select().from(mandates).where(eq(mandates.id, m2.id)))[0].status).toBe("rejected");
    const m3 = await registerMandate(w.db, buyer, bank, gw);
    expect(await ask("cancelled")).toEqual({ active: 0, rejected: 0, revoked: 1 });
    expect((await w.db.select().from(mandates).where(eq(mandates.id, m3.id)))[0]).toMatchObject({ status: "revoked", revokedAt: expect.any(Date) });
  });

  it("one failing lookup does not stop the others", async () => {
    const buyer = { id: w.buyerUserId, role: "buyer", businessId: w.buyerId };
    await registerMandate(w.db, buyer, bank, gw);
    const r = await reconcilePendingMandates(w.db, async () => { throw new Error("provider down"); }, gw);
    expect(r).toEqual({ active: 0, rejected: 0, revoked: 0 });
  });
});
