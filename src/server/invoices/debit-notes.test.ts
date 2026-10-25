import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, invoices, notifications } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { issueDebitNote } from "./debit-notes";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });
const seller = () => ({ id: w.sellerActor.id, role: "seller", businessId: w.sellerId });
const L = 1_00_000_00n;
const get = async (id: string) => (await w.db.select().from(invoices).where(eq(invoices.id, id)))[0];

describe("debit notes", () => {
  it("add a charge as their own linked invoice; the original is untouched, and the buyer is told", async () => {
    const { invoiceId } = await w.offered(10n * L);
    const before = await get(invoiceId);
    const r = await issueDebitNote(w.db, seller(), { invoiceId, amount: 1n * L, reason: "Extra freight" }, gw, T0);
    expect(r.number).toBe(`DN-${before.invoiceNumber}-1`);
    expect(r.status).toBe("validated"); // it goes through the same pipeline: buyer confirmation, underwriting, funding
    expect(r.dueDate).toBe(before.dueDate); // due with the invoice it adds to
    const dn = await get(r.id);
    expect(dn).toMatchObject({ kind: "debit_note", parentInvoiceId: invoiceId, amount: 1n * L, sellerId: w.sellerId, buyerId: w.buyerId, status: "validated" });
    expect(await get(invoiceId)).toMatchObject({ amount: before.amount, status: before.status });
    expect((await w.db.select().from(notifications)).some((n) => n.template === "debit_note_issued" && /Extra freight/.test(n.body ?? ""))).toBe(true);
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "debitnote.issued"))).toHaveLength(1);
  });

  it("numbers run on for the same invoice, and a note can follow a financed or paid invoice", async () => {
    const { invoiceId } = await w.financed(10n * L);
    expect((await issueDebitNote(w.db, seller(), { invoiceId, amount: 1n * L, reason: "Fuel surcharge" }, gw, T0)).number).toMatch(/-1$/);
    await w.db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, invoiceId));
    expect((await issueDebitNote(w.db, seller(), { invoiceId, amount: 2n * L, reason: "Late correction" }, gw, T0)).number).toMatch(/-2$/);
  });

  it("when the original is already past due, the note is due on the credit terms agreed between the two companies", async () => {
    const { invoiceId } = await w.financed(10n * L);
    await w.db.update(invoices).set({ dueDate: "2026-10-01", status: "overdue" }).where(eq(invoices.id, invoiceId));
    const r = await issueDebitNote(w.db, seller(), { invoiceId, amount: 1n * L, reason: "Correction" }, gw, T0);
    expect(r.dueDate).toBe("2026-12-05"); // T0 + the 60 days the pair agreed
  });

  it("only the seller, only with a reason and an amount, only on an accepted invoice, never on a disputed one or on another note", async () => {
    const { invoiceId } = await w.offered(10n * L);
    const ok = { invoiceId, amount: 1n * L, reason: "Extra freight" };
    await expect(issueDebitNote(w.db, { ...seller(), role: "buyer", businessId: w.buyerId }, ok, gw, T0)).rejects.toThrow(/FORBIDDEN/);
    await expect(issueDebitNote(w.db, seller(), { ...ok, reason: "x" }, gw, T0)).rejects.toThrow(/give a reason/);
    await expect(issueDebitNote(w.db, seller(), { ...ok, amount: 0n }, gw, T0)).rejects.toThrow(/more than zero/);
    await w.db.update(invoices).set({ status: "sent_for_confirmation" }).where(eq(invoices.id, invoiceId));
    await expect(issueDebitNote(w.db, seller(), ok, gw, T0)).rejects.toThrow(/needs an invoice the buyer has accepted/);
    await w.db.update(invoices).set({ status: "eligible", disputeFlag: true }).where(eq(invoices.id, invoiceId));
    await expect(issueDebitNote(w.db, seller(), ok, gw, T0)).rejects.toThrow(/in dispute/);
    await w.db.update(invoices).set({ disputeFlag: false }).where(eq(invoices.id, invoiceId));
    const dn = await issueDebitNote(w.db, seller(), ok, gw, T0);
    await expect(issueDebitNote(w.db, seller(), { ...ok, invoiceId: dn.id }, gw, T0)).rejects.toThrow(/not on another debit note/);
  });

  it("is held to the same ticket rules as any invoice", async () => {
    const { invoiceId } = await w.offered(10n * L);
    await expect(issueDebitNote(w.db, seller(), { invoiceId, amount: 100_00n, reason: "Tiny charge" }, gw, T0)).rejects.toThrow(/ticket range/);
  });
});
