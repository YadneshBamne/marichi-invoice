import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, creditNotes, financingOffers, invoices, notifications } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { issueCreditNote } from "./credit-notes";
import { generateOffer } from "../offers/service";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });
const inv = async (id: string) => (await w.db.select().from(invoices).where(eq(invoices.id, id)))[0];
const templates = async () => (await w.db.select().from(notifications)).map((n) => n.template);

describe("credit notes", () => {
  it("before funding: the amount drops, the open offer is withdrawn, the next offer is priced on the new amount", async () => {
    const { offerId, invoiceId } = await w.offered(10_00_000_00n);
    const r = await issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 2_00_000_00n, reason: "goods returned" }, gw, T0);
    expect(r).toMatchObject({ phase: "pre_funding", newAmount: 8_00_000_00n });
    expect((await inv(invoiceId)).amount).toBe(8_00_000_00n);
    expect((await w.db.select().from(financingOffers).where(eq(financingOffers.id, offerId)))[0].status).toBe("rejected");
    expect(r.creditNote.number).toBe(`CN-INV-1-1`);
    const fresh = await generateOffer(w.db, invoiceId, gw, T0);
    if (fresh.unfunded) throw new Error("unfunded");
    expect(fresh.offer.advanceAmount).toBe(7_20_000_00n); // 90% (grade A) of 8,00,000
    expect(await templates()).toContain("credit_note_issued");
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "creditnote.issued")))).toHaveLength(1);
  });

  it("after funding: the invoice shrinks, the buyer and the seller are both told, and the seller is warned about the shortfall", async () => {
    const f = await w.financed(10_00_000_00n);
    const r = await issueCreditNote(w.db, w.sellerActor, { invoiceId: f.invoiceId, amount: 1_00_000_00n, reason: "volume discount" }, gw, T0);
    expect(r.phase).toBe("post_funding");
    expect((await inv(f.invoiceId)).amount).toBe(9_00_000_00n);
    expect(await templates()).toEqual(expect.arrayContaining(["credit_note_issued", "credit_note_shortfall"]));
  });

  it("credit notes stack and are numbered per invoice", async () => {
    const { invoiceId } = await w.offered(10_00_000_00n);
    await issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 1_00_000_00n, reason: "first one" }, gw, T0);
    const second = await issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 1_00_000_00n, reason: "second one" }, gw, T0);
    expect(second.creditNote.number).toBe("CN-INV-1-2");
    expect((await inv(invoiceId)).amount).toBe(8_00_000_00n);
    expect(await w.db.select().from(creditNotes)).toHaveLength(2);
  });

  it("refuses: wrong seller, zero or too-large credit, no reason, accepted-but-unfunded offers, disputes, paid invoices", async () => {
    const { invoiceId } = await w.offered(10_00_000_00n);
    const other = { ...w.sellerActor, businessId: w.buyerId };
    await expect(issueCreditNote(w.db, other, { invoiceId, amount: 1_00n, reason: "not mine" }, gw, T0)).rejects.toThrow("FORBIDDEN");
    await expect(issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 0n, reason: "zero credit" }, gw, T0)).rejects.toThrow(/more than zero/);
    await expect(issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 10_00_000_00n, reason: "whole invoice" }, gw, T0)).rejects.toThrow(/less than the invoice/);
    await expect(issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 1_00n, reason: "" }, gw, T0)).rejects.toThrow(/reason/);
    await w.db.update(invoices).set({ disputeFlag: true }).where(eq(invoices.id, invoiceId));
    await expect(issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 1_00n, reason: "disputed" }, gw, T0)).rejects.toThrow(/dispute/);
    await w.db.update(invoices).set({ disputeFlag: false, status: "paid" }).where(eq(invoices.id, invoiceId));
    await expect(issueCreditNote(w.db, w.sellerActor, { invoiceId, amount: 1_00n, reason: "too late now" }, gw, T0)).rejects.toThrow(/paid/);

    const w2 = await w.acceptedOffer(5_00_000_00n); // accepted, not yet paid out
    const [o] = await w.db.select().from(financingOffers).where(eq(financingOffers.id, w2));
    await expect(issueCreditNote(w.db, w.sellerActor, { invoiceId: o.invoiceId, amount: 1_00n, reason: "after accept" }, gw, T0)).rejects.toThrow(/accepted offer/);
    expect(await w.db.select().from(creditNotes)).toHaveLength(0);
  });
});
