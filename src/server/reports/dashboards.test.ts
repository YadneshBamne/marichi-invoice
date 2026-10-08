import { beforeEach, describe, expect, it } from "vitest";
import { disbursements, invoices } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { createInvoice } from "../invoices/service";
import { sendForConfirmation } from "../confirmations/service";
import { prepareAgreements } from "../agreements/service";
import { recordIncomingPayment, runCollectionsSweep } from "../collections/service";
import { openCase } from "../fraud/service";
import { mock } from "../integrations/mock";
import { formatCompactINR } from "../../lib/money";
import { buyerDashboard, median, opsDashboard, sellerDashboard } from "./dashboards";

let w: Awaited<ReturnType<typeof world>>;
const at = (d: string) => new Date(`${d}T10:00:00Z`);
beforeEach(async () => { w = await world(); });

describe("helpers", () => {
  it("median and compact rupees", () => {
    expect(median([])).toBeNull(); expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 10])).toBe(2.5);
    expect([950n * 100n, 12_400_00n, 8_90_000_00n, 1_20_00_000_00n, -5_00_000_00n].map(formatCompactINR)).toEqual(["₹950", "₹12.4K", "₹8.9L", "₹1.2Cr", "-₹5L"]);
  });
});

describe("sellerDashboard", () => {
  it("empty seller: zeros, full limit available", async () => {
    const d = await sellerDashboard(w.db, w.sellerId, T0);
    expect(d).toMatchObject({ kyb: "approved", outstanding: 0n, available: 1_00_00_000_00n, financedToDate: 0n, feesPaid: 0n, overdue: 0 });
    expect(d.funding7d).toHaveLength(7);
  });

  it("financed invoice: limit used, fees, funding bar, schedule and history", async () => {
    await w.financed();
    const d = await sellerDashboard(w.db, w.sellerId, T0);
    expect(d).toMatchObject({ outstanding: 9_00_000_00n, available: 1_00_00_000_00n - 9_00_000_00n, financedToDate: 9_00_000_00n, feesPaid: 5_000_00n });
    expect(d.funding7d.at(-1)).toEqual({ date: "2026-10-06", amount: 8_95_000_00n });
    expect(d.pipeline).toEqual({ financed: 1 });
    expect(d.upcoming).toEqual([expect.objectContaining({ due: "2026-11-20", buyer: "Big Corp", dpd: 0 })]);
    expect(d.recent[0]).toMatchObject({ number: "INV-1", amount: 8_95_000_00n });
  });

  it("after repayment: limit freed, discount counted in fees paid; overdue is counted before", async () => {
    const f = await w.financed();
    expect((await sellerDashboard(w.db, w.sellerId, at("2026-11-26"))).overdue).toBe(1);
    await recordIncomingPayment(w.db, { accountNumber: f.account, amount: 10_00_000_00n, utr: "U1", receivedAt: at("2026-11-20") }, gw, at("2026-11-20"));
    const d = await sellerDashboard(w.db, w.sellerId, at("2026-11-21"));
    expect(d.outstanding).toBe(0n);
    expect(d.feesPaid).toBe(5_000_00n + 13_315_06n);
    expect(d.overdue).toBe(0);
  });

  it("attention items: documents to sign", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    expect((await sellerDashboard(w.db, w.sellerId, T0)).attention).toMatchObject({ toSign: 2, offers: 0 });
  });

  it("is scoped to the seller", async () => {
    await w.financed();
    expect((await sellerDashboard(w.db, w.buyerId, T0)).outstanding).toBe(0n);
  });
});

describe("buyerDashboard", () => {
  it("pending confirmations, payables window, suppliers", async () => {
    const { id } = await createInvoice(w.db, { sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: "P-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 5_00_000_00n, contentHash: "p1" }, mock, T0);
    await sendForConfirmation(w.db, id, gw, T0);
    let d = await buyerDashboard(w.db, w.buyerId, T0);
    expect(d).toMatchObject({ pendingCount: 1, pendingValue: 5_00_000_00n, due30Count: 0, overdueCount: 0 });
    expect(d.awaiting[0]).toMatchObject({ number: "P-1", seller: "Seller Co" });

    await w.financed(); // a second, funded invoice from the same seller
    d = await buyerDashboard(w.db, w.buyerId, at("2026-11-01")); // 19 days before it falls due
    expect(d.due30Count).toBe(1);
    expect(d.due30Value).toBe(10_00_000_00n);
    expect(d.suppliers).toEqual([expect.objectContaining({ seller: "Seller Co", invoices: 2, volume: 10_00_000_00n, terms: 60 })]);
    expect((await buyerDashboard(w.db, w.buyerId, at("2026-11-26"))).overdueCount).toBe(1);
    expect((await buyerDashboard(w.db, w.sellerId, T0)).pendingCount).toBe(0); // scoped
  });
});

describe("opsDashboard", () => {
  it("GTV, book, delinquency buckets and capital use come from the books", async () => {
    await w.financed();
    const d = await opsDashboard(w.db, at("2026-10-20"));
    expect(d.gtvMonth).toBe(9_00_000_00n);
    expect(d.months.at(-1)).toMatchObject({ label: "Oct", amount: 9_00_000_00n });
    expect(d.book).toBe(9_00_000_00n);
    expect(d.buckets["0"]).toBe(9_00_000_00n);
    expect(d.npaPct).toBe(0);
    expect(d.deployed).toBe(9_00_000_00n);
    expect(d.utilizationPct).toBeCloseTo(1.8, 1);
    expect(d.escrow).toBe(50_00_000_00n - 8_95_000_00n);

    await runCollectionsSweep(w.db, gw, at("2027-02-01")); // ~73 days past due
    const late = await opsDashboard(w.db, at("2027-02-01"));
    expect(late.buckets["61-90"]).toBe(9_00_000_00n);
    expect(late.npaPct).toBe(100);
    expect(d.gtvChangePct).toBeNull(); // no previous month to compare with
    expect((await opsDashboard(w.db, at("2026-11-10"))).gtvChangePct).toBe(-100); // nothing funded in Nov vs ₹9L in Oct
  });

  it("funnel counts uploads through funding; queues reflect open work", async () => {
    await w.financed();
    await openCase(w.db, { entityType: "invoice", entityId: (await w.db.select().from(invoices))[0].id, rule: "irn_cancelled" });
    const d = await opsDashboard(w.db, new Date()); // invoices are stamped with real DB time
    expect(d.funnel).toMatchObject({ uploaded: 1, offered: 1, accepted: 1, funded: 1 });
    expect(d.fraud).toEqual({ open: 1, high: 1 });
    expect(d.queues).toMatchObject({ kyb: 0, unmatched: 0, failedPayouts: 0, approvals: 0 });
    expect(d.recon).toBeNull();
    await w.db.update(disbursements).set({ status: "failed" });
    expect((await opsDashboard(w.db, new Date())).queues.failedPayouts).toBe(1);
  });
});
