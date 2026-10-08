// The second walkthrough, as one executable script. Each block is a scenario an operator or a reviewer can follow in the product:
//   A. a buyer pays late        B. the fraud queue stops an offer     C. a large invoice goes to manual underwriting and a second approver
//   D. a buyer disputes after the money is out.
// Every scenario crosses several modules, so this is the check that they still agree with each other.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, collectionEvents, disbursements, financingOffers, invoices, notifications, repayments } from "./db/schema";
import { gw, T0, world } from "./testkit";
import { createInvoice } from "./invoices/service";
import { recordConsent, reviewUnderwriting, underwriteInvoice } from "./underwriting/service";
import { acceptOffer, generateOffer } from "./offers/service";
import { prepareAgreements, signInApp } from "./agreements/service";
import { approveDisbursement, executeDisbursement, fundEscrow, requestDisbursement } from "./disbursements/service";
import { recordIncomingPayment, runCollectionsSweep } from "./collections/service";
import { scanInvoice } from "./fraud/engine";
import { assertNotFrozen, listCases, resolveCase } from "./fraud/service";
import { raiseDispute, resolveDispute } from "./support/disputes";
import { mock } from "./integrations/mock";
import { ACCOUNTS, balance } from "./ledger/accounts";

let w: Awaited<ReturnType<typeof world>>;
const L = 1_00_000_00n;
const at = (d: string) => new Date(`${d}T10:00:00Z`);
const ops = (n: number) => ({ id: `00000000-0000-0000-0000-0000000000a${n}`, role: "ops" });
const admin = { id: "00000000-0000-0000-0000-0000000000b1", role: "admin" };
const compliance = { id: "00000000-0000-0000-0000-0000000000c1", role: "compliance" };
const buyerActor = () => ({ id: w.buyerUserId, email: "ap@big.com", role: "buyer", businessId: w.buyerId });
const status = async (id: string) => (await w.db.select().from(invoices).where(eq(invoices.id, id)))[0].status;
const templates = async () => (await w.db.select().from(notifications)).map((n) => n.template);
const pay = (account: string, amount: bigint, day: string, utr: string) =>
  recordIncomingPayment(w.db, { accountNumber: account, amount, utr, receivedAt: at(day) }, gw, at(day));
beforeEach(async () => { w = await world(); });

describe("A. the buyer pays late", () => {
  it("goes overdue, the seller gets the recourse notice, penal charges accrue and are collected last, and the invoice closes", async () => {
    const f = await w.financed(); // ₹10L invoice, ₹9L advance, due 2026-11-20
    await runCollectionsSweep(w.db, gw, at("2026-11-19"));
    expect(await status(f.invoiceId)).toBe("financed");
    await runCollectionsSweep(w.db, gw, at("2026-11-20"));
    expect(await status(f.invoiceId)).toBe("due");
    await runCollectionsSweep(w.db, gw, at("2026-12-10")); // 20 days late
    expect(await status(f.invoiceId)).toBe("overdue");
    const sent = await templates();
    expect(sent).toEqual(expect.arrayContaining(["payment_overdue", "recourse_notice"]));

    // A part-payment is applied principal first, then discount, then penal charges.
    const part = await pay(f.account, 5n * L, "2026-12-11", "WT-A1");
    expect(part).toMatchObject({ status: "applied", closed: false });
    expect(await status(f.invoiceId)).toBe("overdue");
    // The rest arrives: whatever penal charges were left are cleared, the invoice closes, and any excess goes back to the seller.
    const rest = await pay(f.account, 6n * L, "2026-12-12", "WT-A2");
    expect(rest).toMatchObject({ status: "applied", closed: true });
    expect(await status(f.invoiceId)).toBe("paid");
    const allocations = (await w.db.select().from(repayments)).map((r) => r.allocation as Record<string, string>);
    const penal = allocations.reduce((a, x) => a + BigInt(x.penal), 0n);
    expect(penal).toBeGreaterThan(0n); // lateness cost something
    expect(-(await balance(w.db, ACCOUNTS.penalIncome))).toBe(penal); // and the ledger booked exactly that, only when received
    expect(await balance(w.db, ACCOUNTS.receivable(w.sellerId))).toBe(0n);
  });
});

describe("B. the fraud queue stops an offer", () => {
  it("an open case freezes the invoice even with an offer already out; clearing it lets the seller accept", async () => {
    const { offerId, invoiceId } = await w.offered();
    // The seller and buyer turn out to share a PAN: a related-party signal that is serious on its own.
    await w.db.update(businesses).set({ gstin: "27ABCDE1234F1Z5" }).where(eq(businesses.id, w.sellerId));
    await w.db.update(businesses).set({ gstin: "29ABCDE1234F1Z9" }).where(eq(businesses.id, w.buyerId));
    const scan = await scanInvoice(w.db, invoiceId, at("2026-10-07"));
    expect(scan.flag).toBe(true);
    expect((await listCases(w.db)).map((c) => c.entityId)).toContain(invoiceId);
    await expect(assertNotFrozen(w.db, invoiceId)).rejects.toThrow();
    await expect(acceptOffer(w.db, offerId, w.sellerActor, T0)).rejects.toThrow();

    await expect(resolveCase(w.db, { caseId: scan.caseId!, staff: ops(1), outcome: "cleared", note: "checked" })).rejects.toThrow("forbidden"); // only compliance or admin
    await resolveCase(w.db, { caseId: scan.caseId!, staff: compliance, outcome: "cleared", note: "related by group structure, documented, fine" });
    await expect(acceptOffer(w.db, offerId, w.sellerActor, T0)).resolves.toBe(offerId);
  });
});

describe("C. a large invoice needs an analyst and a second approver", () => {
  it("is referred, approved by an analyst, and the payout waits for a different person than the one who queued it", async () => {
    const { id } = await createInvoice(w.db, {
      sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: "BIG-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20",
      amount: 30n * L, contentHash: "wt-big", irn: "IRN-OK-BIG",
    }, mock, T0);
    await w.db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id));
    const d = await underwriteInvoice(w.db, id, gw, T0);
    expect(d.decision).toBe("referred"); // above the grade's auto-approval limit
    await expect(generateOffer(w.db, id, gw, T0)).rejects.toThrow("not approved");
    await reviewUnderwriting(w.db, { decisionId: d.id, reviewerId: ops(1).id, reviewerRole: "ops", outcome: "approve", note: "financials checked" });
    const o = await generateOffer(w.db, id, gw, T0);
    if (o.unfunded) throw new Error("unfunded");
    await acceptOffer(w.db, o.offer.id, w.sellerActor, T0);
    await prepareAgreements(w.db, o.offer.id, gw, T0);
    await signInApp(w.db, { offerId: o.offer.id, actor: w.sellerActor }, T0);
    await fundEscrow(w.db, { amount: 50n * L * 100n, ref: "wt-fund", staffId: ops(1).id, staffRole: "ops" });

    const queued = await requestDisbursement(w.db, o.offer.id, ops(1).id);
    expect(queued.needsApproval).toBe(true); // ₹27L advance is over the ₹10L line
    await expect(executeDisbursement(w.db, queued.id, gw, T0)).rejects.toThrow("APPROVAL_REQUIRED");
    await expect(approveDisbursement(w.db, queued.id, ops(1), T0)).rejects.toThrow("maker cannot approve");
    await approveDisbursement(w.db, queued.id, ops(2), T0);
    expect(await executeDisbursement(w.db, queued.id, gw, T0)).toEqual({ status: "succeeded" });
    expect(await status(id)).toBe("financed");
    expect((await w.db.select().from(disbursements).where(eq(disbursements.id, queued.id)))[0].status).toBe("succeeded");
  });
});

describe("D. the buyer disputes after the money is out", () => {
  it("pauses overdue handling and reminders while open, accrual carries on, and everything resumes when the invoice stands", async () => {
    const f = await w.financed();
    const ticket = await raiseDispute(w.db, { invoiceId: f.invoiceId, actor: buyerActor(), reason: "goods short-delivered" }, gw, at("2026-11-25"));
    expect((await w.db.select().from(invoices).where(eq(invoices.id, f.invoiceId)))[0].disputeFlag).toBe(true);

    await runCollectionsSweep(w.db, gw, at("2026-12-10")); // well past the grace period
    expect(await status(f.invoiceId)).toBe("financed"); // not pushed to overdue while disputed
    expect(await w.db.select().from(collectionEvents).where(eq(collectionEvents.invoiceId, f.invoiceId))).toHaveLength(0); // no reminders, no recourse notice
    const accruedWhileDisputed = await balance(w.db, ACCOUNTS.accruedDiscount);
    expect(accruedWhileDisputed).toBeGreaterThan(0n);

    await resolveDispute(w.db, { ticketId: ticket.id, staff: { ...admin, businessId: null }, outcome: "invoice_stands", note: "buyer accepted delivery after inspection" }, gw, at("2026-12-11"));
    await runCollectionsSweep(w.db, gw, at("2026-12-12"));
    expect(await status(f.invoiceId)).toBe("overdue"); // the clock was only paused
    expect(await templates()).toContain("recourse_notice");
    void financingOffers;
  });
});
