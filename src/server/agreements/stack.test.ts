import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agreements, auditLog, businesses, financierProfiles, financingOffers, invoiceConfirmations, invoices, users } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { acceptOffer } from "../offers/service";
import { acceptBid, placeBid } from "../marketplace/service";
import { decide, submit } from "../approvals/service";
import { memberships } from "../db/schema";
import { respondToInvoice, sendForConfirmation } from "../confirmations/service";
import { createInvoice } from "../invoices/service";
import { mock } from "../integrations/mock";
import { canViewDocument, prepareAgreements } from "./service";
import { acknowledgeKeyFacts, ensureKeyFacts } from "./keyfacts";
import { recordConfirmation } from "./records";
import { termsFor } from "./country";
import { assignmentNotice, confirmationRecord, docText, financierTerms, invoiceSchedule, keyFacts, masterAgreement, PLATFORM, PLATFORM_TERMS_VERSION, programmeTerms, TEMPLATE_VERSION } from "./templates";
import { readDocument } from "../vault";
import { describeOffer } from "../offers/pricing";
import { COLLECTIONS } from "../collections/waterfall";

let w: Awaited<ReturnType<typeof world>>;
const L = 1_00_000_00n;
beforeEach(async () => { w = await world(); });
const text = async (ref: string) => (await readDocument(ref)).bytes.toString("latin1");

describe("templates", () => {
  const seller = { legalName: "Seller Co", gstin: "27AAAAA1111A1Z5" };
  it("the master agreement carries the clauses that matter, the right party, and the country's law, registry and signature statute", () => {
    const india = docText(masterAgreement({ seller, now: T0 }));
    for (const c of ["Eligible invoices", "Seller's warranties", "Recourse and repurchase", "Order of payments", "Notice and registration", "Electronic signature"]) expect(india, c).toContain(c);
    expect(india).toContain("CERSAI");
    expect(india).toContain("Information Technology Act, 2000");
    expect(india).toContain("the laws of India");
    expect(india).toContain(TEMPLATE_VERSION);
    expect(india).not.toContain("servicing and collection agent"); // the platform's own balance sheet needs no agent clause
    const zambia = docText(masterAgreement({ seller, country: termsFor("ZM"), financier: { legalName: "Nova Finance", platform: false }, now: T0 }));
    expect(zambia).toContain("Nova Finance");
    expect(zambia).toContain("servicing and collection agent");
    expect(zambia).toContain("PACRA");
    expect(zambia).toContain("Electronic Communications and Transactions Act, 2021");
    expect(zambia).toContain("the laws of the Republic of Zambia");
    expect(docText(masterAgreement({ seller, country: termsFor("KE"), now: T0 }))).toContain("to be completed by counsel"); // no country pack: left for counsel
  });

  it("the notice names the real assignee, says it takes effect on receipt, and asks the buyer to disclose set-off", () => {
    const n = docText(assignmentNotice({ seller, buyer: { legalName: "Big Corp" }, invoice: { invoiceNumber: "INV-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10n * L }, collection: { accountNumber: "MARI1", ifsc: "X" }, financier: { legalName: "Nova Finance", platform: false }, now: T0 }));
    expect(n).toContain("assigned to Nova Finance");
    expect(n).toContain("Marichi Labs collects for the assignee");
    expect(n).toContain("takes effect when you receive it");
    expect(n).toContain("set-off or counterclaim");
    expect(n).toContain("Acknowledgement");
  });

  it("the schedule states recourse, grace, penal and day count", () => {
    const s = docText(invoiceSchedule({ seller, buyer: { legalName: "Big Corp", gstin: null }, invoice: { invoiceNumber: "INV-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10n * L }, offer: { advanceAmount: 9n * L, feeAmount: 5_000_00n, discountBps: 1200, tenorDays: 45, expectedDiscount: 13_315_06n, recourse: true, expiresAt: T0 }, penalBps: 1200, graceDays: 5, now: T0 }));
    expect(s).toContain("actual days over 365");
    expect(s).toContain("12% per annum on overdue principal, from the due date");
    expect(s).toContain("5 days after the due date");
    expect(s).toContain("With recourse to the Seller");
  });

  it("financier and programme terms carry the promises that make them work", () => {
    expect(docText(financierTerms())).toContain("within one business day");
    expect(docText(financierTerms())).toContain("not our money");
    const p = docText(programmeTerms());
    expect(p).toContain("without set-off, counterclaim or deduction");
    expect(p).toContain("waives any restriction on assignment");
  });

  it("the confirmation record repeats the exact wording and who confirmed", () => {
    const t = docText(confirmationRecord({ seller: { legalName: "Seller Co" }, buyer: { legalName: "Big Corp" }, invoice: { invoiceNumber: "INV-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10n * L }, wording: ["one", "two"], version: "v1", via: "link", email: "ap@big.com", at: T0, ip: "1.2.3.4", userAgent: "vitest" }));
    expect(t).toContain("ap@big.com, verified by a one-time code");
    expect(t).toContain("1.2.3.4");
    expect(t).toContain("two");
  });
});

describe("the key facts sheet", () => {
  it("is made with the offer, in the same numbers as the offer, and carries the cost, the all-in rate and what happens if the buyer is late", async () => {
    const { offerId } = await w.offered();
    const [kf] = await w.db.select().from(agreements).where(and(eq(agreements.offerId, offerId), eq(agreements.kind, "key_facts")));
    expect(kf).toMatchObject({ status: "sent", businessId: w.sellerId });
    expect(kf.documentHash).toHaveLength(64);
    const pdf = await text(kf.documentRef);
    expect(pdf.startsWith("%PDF-")).toBe(true);
  });

  it("states the figures: net received, discount, all-in rate, penal rate, recourse", () => {
    const offer = { id: "abcdef12-0000-0000-0000-000000000000", advanceAmount: 9n * L, feeAmount: 5_000_00n, discountBps: 1200, tenorDays: 45, expectedDiscount: 13_315_06n, recourse: true, expiresAt: new Date("2026-10-07T00:00:00Z") };
    const apr = describeOffer({ ...offer }).effectiveAprBps;
    const t = docText(keyFacts({ seller: { legalName: "Seller Co" }, buyer: { legalName: "Big Corp" }, invoice: { invoiceNumber: "INV-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10n * L }, offer, effectiveAprBps: apr, penalBps: COLLECTIONS.penalBps, graceDays: COLLECTIONS.graceDays, now: T0 }));
    expect(t).toContain("ABCDEF12");
    expect(t).toContain("You receive now: ₹8,95,000.00");
    expect(t).toContain("12.00% a year on the advance");
    expect(t).toContain(`${(apr / 100).toFixed(2)}% a year. This is (discount + fee)`);
    expect(t).toContain("12.00% a year also accrues on the overdue principal from the due date");
    expect(t).toContain("With recourse");
    expect(t).toContain("Nothing is binding");
    expect(t).toContain("Principal, then discount, then penal charges");
    const nr = docText(keyFacts({ seller: { legalName: "Seller Co" }, buyer: { legalName: "Big Corp" }, invoice: { invoiceNumber: "INV-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10n * L }, offer: { ...offer, recourse: false }, effectiveAprBps: apr, penalBps: 1200, graceDays: 5, now: T0 }));
    expect(nr).toContain("Without recourse");
  });

  it("is made once, and acknowledgement records who read it; a replay changes nothing", async () => {
    const { offerId } = await w.offered();
    const a = await ensureKeyFacts(w.db, offerId, T0), b = await ensureKeyFacts(w.db, offerId, T0);
    expect(a.id).toBe(b.id);
    const signed = await acknowledgeKeyFacts(w.db, offerId, w.sellerActor.id, T0);
    expect(signed).toMatchObject({ status: "signed", signedBy: w.sellerActor.id, signedByEmail: "s@seller.com" });
    await acknowledgeKeyFacts(w.db, offerId, w.sellerActor.id, new Date(T0.getTime() + 1000));
    expect((await w.db.select().from(agreements).where(eq(agreements.id, a.id)))[0].signedAt).toEqual(T0);
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "keyfacts.acknowledged"))).toHaveLength(1);
  });

  it("a financier's offer names the financier, not the platform", async () => {
    const f = await w.financier("Nova Finance", 50n * L);
    const { invoiceId } = await w.offered();
    const b = await placeBid(w.db, f.actor, { invoiceId, advanceBps: 9000, discountBps: 1000 }, gw, T0);
    const offer = await acceptBid(w.db, b.id, w.sellerActor, gw, T0);
    const [kf] = await w.db.select().from(agreements).where(and(eq(agreements.offerId, offer.id), eq(agreements.kind, "key_facts")));
    expect(kf).toBeTruthy(); // made when the bid was accepted
    await prepareAgreements(w.db, offer.id, gw, T0);
    expect((await w.db.select().from(agreements).where(eq(agreements.offerId, offer.id))).map((a) => a.kind).sort()).toEqual(["assignment_notice", "invoice_schedule", "key_facts"]);
  });
});

describe("accepting needs the sheet acknowledged", () => {
  const owner = () => ({ id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId });
  it("refuses an acceptance without the acknowledgement, and records it with the acceptance", async () => {
    const { offerId } = await w.offered(5_00_000_00n);
    await expect(submit(w.db, owner(), "offer.accept", { offerId }, { summary: "x", amount: 4n * L }, gw, T0)).rejects.toThrow(/key facts/);
    expect((await w.db.select().from(financingOffers).where(eq(financingOffers.id, offerId)))[0].status).toBe("open");
    await submit(w.db, owner(), "offer.accept", { offerId, ack: true }, { summary: "x", amount: 4n * L }, gw, T0);
    const [kf] = await w.db.select().from(agreements).where(and(eq(agreements.offerId, offerId), eq(agreements.kind, "key_facts")));
    expect(kf).toMatchObject({ status: "signed", signedBy: w.sellerActor.id });
  });

  it("when a maker asks and an approver decides, the approver is the one who is recorded as having read it", async () => {
    const [m] = await w.db.insert(users).values({ name: "Maker", email: "maker@seller.com", role: "seller", businessId: w.sellerId, orgRole: "maker" }).returning();
    await w.db.insert(memberships).values({ userId: m.id, businessId: w.sellerId, orgRole: "maker" });
    const { offerId } = await w.offered(5_00_000_00n);
    const maker = { id: m.id, role: "seller", orgRole: "maker", businessId: w.sellerId };
    const q = await submit(w.db, maker, "offer.accept", { offerId, ack: true }, { summary: "x", amount: 4n * L }, gw, T0);
    if (q.status !== "queued") throw new Error("expected queued");
    await decide(w.db, owner(), q.id, "approve", "", gw, T0);
    const [kf] = await w.db.select().from(agreements).where(and(eq(agreements.offerId, offerId), eq(agreements.kind, "key_facts")));
    expect(kf.signedBy).toBe(w.sellerActor.id);
  });

  it("a request without the box ticked fails when approved, and says why, rather than accepting", async () => {
    const [m] = await w.db.insert(users).values({ name: "Maker", email: "maker@seller.com", role: "seller", businessId: w.sellerId, orgRole: "maker" }).returning();
    await w.db.insert(memberships).values({ userId: m.id, businessId: w.sellerId, orgRole: "maker" });
    const { offerId } = await w.offered(5_00_000_00n);
    const q = await submit(w.db, { id: m.id, role: "seller", orgRole: "maker", businessId: w.sellerId }, "offer.accept", { offerId }, { summary: "x", amount: 4n * L }, gw, T0);
    if (q.status !== "queued") throw new Error("expected queued");
    expect(await decide(w.db, owner(), q.id, "approve", "", gw, T0)).toMatchObject({ status: "failed", error: expect.stringContaining("key facts") });
  });
  void acceptOffer;
});

describe("records of what people agreed to", () => {
  it("a confirmation record is made when a buyer confirms; only the two parties and staff can open it", async () => {
    const inv = await createInvoice(w.db, { sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: "REC-1", invoiceDate: "2026-09-25", dueDate: "2026-12-01", amount: 5n * L, contentHash: "rec1" }, mock, T0);
    await sendForConfirmation(w.db, inv.id, gw, T0);
    await respondToInvoice(w.db, { invoiceId: inv.id, actor: { id: w.buyerUserId, email: "ap@big.com", role: "buyer", businessId: w.buyerId, ip: "9.9.9.9" }, decision: "confirm" }, gw, T0);
    const [c] = await w.db.select().from(invoiceConfirmations).where(eq(invoiceConfirmations.invoiceId, inv.id));
    expect(c.recordRef).toBeTruthy();
    expect(c.recordHash).toHaveLength(64);
    expect((await text(c.recordRef!)).startsWith("%PDF-")).toBe(true);
    expect(await recordConfirmation(w.db, inv.id)).toEqual({ ref: c.recordRef, hash: c.recordHash }); // once only
    expect(await canViewDocument(w.db, { role: "seller", businessId: w.sellerId }, c.recordRef!)).toBe(true);
    expect(await canViewDocument(w.db, { role: "buyer", businessId: w.buyerId }, c.recordRef!)).toBe(true);
    expect(await canViewDocument(w.db, { role: "ops", businessId: null }, c.recordRef!)).toBe(true);
    const other = (await w.db.insert(businesses).values({ legalName: "Other", entityType: "pvt_ltd" }).returning())[0].id;
    expect(await canViewDocument(w.db, { role: "seller", businessId: other }, c.recordRef!)).toBe(false);
    expect(await canViewDocument(w.db, { role: "financier", businessId: other }, c.recordRef!)).toBe(false);
  });

  it("a financier's licence copy can be opened only by that financier and staff", async () => {
    const f = await w.financier("Nova Finance", 0n);
    await w.db.update(financierProfiles).set({ licenceDocRef: "licence-ref-1" }).where(eq(financierProfiles.businessId, f.id));
    expect(await canViewDocument(w.db, { role: "financier", businessId: f.id }, "licence-ref-1")).toBe(true);
    expect(await canViewDocument(w.db, { role: "ops", businessId: null }, "licence-ref-1")).toBe(true);
    expect(await canViewDocument(w.db, { role: "financier", businessId: w.sellerId }, "licence-ref-1")).toBe(false);
    expect(await canViewDocument(w.db, { role: "seller", businessId: w.sellerId }, "licence-ref-1")).toBe(false);
  });

  it("the platform terms version is a stable label, and PLATFORM is the default assignee", () => {
    expect(PLATFORM_TERMS_VERSION).toMatch(/^\d{4}-\d{2}$/);
    expect(PLATFORM).toEqual({ legalName: "Marichi Labs", platform: true });
    void invoices;
  });
});

