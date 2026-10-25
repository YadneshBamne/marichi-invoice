import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bids, businesses, financierBuyerLimits, financierMandates, financierProfiles, financingOffers, invoices, notifications, underwritingDecisions, users } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { prepareAgreements, signInApp } from "../agreements/service";
import { executeDisbursement, requestDisbursement } from "../disbursements/service";
import { generateOffer, acceptOffer } from "../offers/service";
import { OFFER } from "../offers/pricing";
import { acceptBid, placeBid, recordFunding } from "./service";
import { runAutoBids } from "./auto";
import { assertActiveFinancier, listLimits, mandateOf, profileOf, reviewApplication, saveApplication, saveMandate, setBuyerLimit, type Actor, type Application, type MandateInput } from "./financier";

let w: Awaited<ReturnType<typeof world>>;
const L = 1_00_000_00n;
const ops = { staffId: "00000000-0000-0000-0000-0000000000a1", staffRole: "ops" };
const staff = { id: "00000000-0000-0000-0000-0000000000a1", role: "ops" };
beforeEach(async () => { w = await world(); });

const actor = (f: { actor: { id: string; businessId: string } }, orgRole = "owner"): Actor => ({ id: f.actor.id, role: "financier", orgRole, businessId: f.actor.businessId });
const bid = (f: { actor: { id: string; businessId: string } }, invoiceId: string, discountBps = 1000, advanceBps = 9000, now = T0) =>
  placeBid(w.db, { id: f.actor.id, role: "financier", businessId: f.actor.businessId }, { invoiceId, advanceBps, discountBps }, gw, now);
const MANDATE: MandateInput = { status: "active", minTicket: 0n, maxTicket: null, minTenorDays: 1, maxTenorDays: 365, minGrade: "E", maxPerSeller: null, sectors: [], autoBid: false, autoDiscountBps: null, autoAdvanceBps: null };
const mandate = (f: { id: string }, m: Partial<MandateInput>) => saveMandate(w.db, { id: "00000000-0000-0000-0000-0000000000f1", role: "financier", orgRole: "owner", businessId: f.id }, { ...MANDATE, ...m });
const APP: Application = {
  institutionType: "nbfc_factor", countries: ["in"], regulator: "RBI", licenceType: "NBFC-Factor", licenceNumber: "N-14.03456", licenceValidUntil: "2030-01-01",
  licenceDocRef: "doc-ref", settlementAccount: "123456789012", settlementIfsc: "hdfc0001234", settlementName: "Nova Finance",
};

/** A new financier company with a login, KYB approved, but no application yet. */
async function applicant(kyb: "approved" | "under_review" = "approved") {
  const [b] = await w.db.insert(businesses).values({ legalName: "Nova Finance", entityType: "nbfc", kybStatus: kyb, kind: "financier" }).returning();
  const [u] = await w.db.insert(users).values({ name: "Nova", email: `${b.id}@nova.com`, role: "financier", businessId: b.id, orgRole: "owner" }).returning();
  return { id: b.id, actor: { id: u.id, role: "financier", orgRole: "owner", businessId: b.id } as Actor };
}

describe("the application", () => {
  it("is saved as a draft, then submitted; staff are told, the licence is normalised and the settlement account is checked", async () => {
    const f = await applicant();
    await w.db.insert(users).values({ name: "Comp", email: "c@m.com", role: "compliance" });
    expect(await saveApplication(w.db, f.actor, APP, false, gw, T0)).toMatchObject({ submitted: false });
    expect((await profileOf(w.db, f.id)).status).toBe("draft");
    expect(await saveApplication(w.db, f.actor, APP, true, gw, T0)).toMatchObject({ submitted: true, settlementVerified: true });
    const p = await profileOf(w.db, f.id);
    expect(p).toMatchObject({ status: "submitted", countries: ["IN"], settlementIfsc: "HDFC0001234", licenceNumber: "N-14.03456" });
    expect(p.settlementAccount).toBe("123456789012"); // encrypted at rest, plain through the model
    expect((await w.db.select().from(notifications)).map((n) => n.template)).toContain("financier_application");
  });

  it("needs the basics, a licence copy, an unexpired licence and countries as two-letter codes", async () => {
    const f = await applicant();
    await expect(saveApplication(w.db, f.actor, { ...APP, countries: [] }, true, gw, T0)).rejects.toThrow(/countries/);
    await expect(saveApplication(w.db, f.actor, { ...APP, countries: ["India"] }, true, gw, T0)).rejects.toThrow(/two-letter/);
    await expect(saveApplication(w.db, f.actor, { ...APP, institutionType: "hedge" }, true, gw, T0)).rejects.toThrow(/kind of institution/);
    await expect(saveApplication(w.db, f.actor, { ...APP, licenceNumber: "" }, true, gw, T0)).rejects.toThrow(/licence number/);
    await expect(saveApplication(w.db, f.actor, { ...APP, licenceValidUntil: "2026-01-01" }, true, gw, T0)).rejects.toThrow(/expired/);
    await expect(saveApplication(w.db, f.actor, { ...APP, licenceDocRef: null }, true, gw, T0)).rejects.toThrow(/copy of the licence/);
    await expect(saveApplication(w.db, f.actor, { ...APP, settlementAccount: "1" }, true, gw, T0)).rejects.toThrow(/account/);
  });

  it("only an owner or approver may apply, and it cannot be edited while under review", async () => {
    const f = await applicant();
    for (const orgRole of ["maker", "admin", "viewer"]) await expect(saveApplication(w.db, { ...f.actor, orgRole }, APP, true, gw, T0)).rejects.toThrow(/not allowed/);
    await saveApplication(w.db, f.actor, APP, true, gw, T0);
    await expect(saveApplication(w.db, f.actor, APP, true, gw, T0)).rejects.toThrow(/cannot be edited/);
  });
});

describe("staff review", () => {
  async function submitted(kyb: "approved" | "under_review" = "approved") {
    const f = await applicant(kyb);
    await saveApplication(w.db, f.actor, APP, true, gw, T0);
    return f;
  }
  it("approval needs the company verified and an unexpired licence, and creates a default mandate", async () => {
    const unverified = await submitted("under_review");
    await expect(reviewApplication(w.db, staff, unverified.id, "approve", "", gw, T0)).rejects.toThrow(/KYB/);
    const f = await submitted();
    await expect(reviewApplication(w.db, { ...staff, role: "seller" }, f.id, "approve", "", gw, T0)).rejects.toThrow(/forbidden/);
    await expect(reviewApplication(w.db, staff, f.id, "approve", "", gw, new Date("2031-01-01T00:00:00Z"))).rejects.toThrow(/expired/);
    await reviewApplication(w.db, staff, f.id, "approve", "licence checked on the RBI list", gw, T0);
    expect(await profileOf(w.db, f.id)).toMatchObject({ status: "approved", reviewedBy: staff.id });
    expect(await mandateOf(w.db, f.id)).toMatchObject({ status: "active", minGrade: "C", autoBid: false });
    await assertActiveFinancier(w.db, f.id, "IN", T0);
  });
  it("rejecting and asking for information need a note; the applicant can fix and resubmit", async () => {
    const f = await submitted();
    await expect(reviewApplication(w.db, staff, f.id, "reject", " ", gw, T0)).rejects.toThrow(/note/);
    await reviewApplication(w.db, staff, f.id, "request_info", "send a clearer licence copy", gw, T0);
    expect((await profileOf(w.db, f.id)).note).toBe("send a clearer licence copy");
    await saveApplication(w.db, f.actor, { ...APP, licenceNumber: "N-14.03456-B" }, true, gw, T0);
    expect(await profileOf(w.db, f.id)).toMatchObject({ status: "submitted", note: null, licenceNumber: "N-14.03456-B" });
    await reviewApplication(w.db, staff, f.id, "reject", "not licensed for this activity", gw, T0);
    await expect(assertActiveFinancier(w.db, f.id, "IN", T0)).rejects.toThrow(/not been approved/);
    await expect(reviewApplication(w.db, staff, f.id, "approve", "", gw, T0)).rejects.toThrow(/cannot approve/);
  });
  it("suspension stops everything straight away and reinstatement restores it", async () => {
    const f = await submitted();
    await reviewApplication(w.db, staff, f.id, "approve", "", gw, T0);
    await reviewApplication(w.db, staff, f.id, "suspend", "regulator notice", gw, T0);
    await expect(assertActiveFinancier(w.db, f.id, "IN", T0)).rejects.toThrow(/suspended/);
    await expect(recordFunding(w.db, { financierId: f.id, amount: L, ref: "s", ...ops })).rejects.toThrow(/not approved/);
    await reviewApplication(w.db, staff, f.id, "reinstate", "cleared", gw, T0);
    await assertActiveFinancier(w.db, f.id, "IN", T0);
  });
});

describe("what a bid must satisfy", () => {
  it("a company with no approved application cannot hold funds or bid", async () => {
    const f = await applicant();
    await expect(recordFunding(w.db, { financierId: f.id, amount: L, ref: "x", ...ops })).rejects.toThrow(/application/);
  });

  it("a lapsed licence stops bidding; a country the financier is not licensed in is refused", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    await w.db.update(financierProfiles).set({ licenceValidUntil: "2026-10-01" }).where(eq(financierProfiles.businessId, f.id));
    await expect(bid(f, invoiceId)).rejects.toThrow(/licence has expired/);
    await w.db.update(financierProfiles).set({ licenceValidUntil: "2030-12-31" }).where(eq(financierProfiles.businessId, f.id));
    await w.db.update(businesses).set({ country: "ZM" }).where(eq(businesses.id, w.sellerId));
    await expect(bid(f, invoiceId)).rejects.toThrow(/not licensed to fund in ZM/);
    await w.db.update(financierProfiles).set({ countries: ["IN", "ZM"] }).where(eq(financierProfiles.businessId, f.id));
    await bid(f, invoiceId);
  });

  it("ticket size, tenor, grade and sector from the mandate each stop a bid, with the reason", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered(); // ₹10L invoice, ₹9L advance, 45 days, grade A
    await mandate(f, { minTicket: 10n * L });
    await expect(bid(f, invoiceId)).rejects.toThrow(/below your smallest ticket/);
    await mandate(f, { maxTicket: 5n * L });
    await expect(bid(f, invoiceId)).rejects.toThrow(/above your largest ticket/);
    await mandate(f, { maxTenorDays: 30 });
    await expect(bid(f, invoiceId)).rejects.toThrow(/tenor/);
    await mandate(f, { minTenorDays: 60 });
    await expect(bid(f, invoiceId)).rejects.toThrow(/tenor/);
    await w.db.update(underwritingDecisions).set({ riskGrade: "D" }).where(eq(underwritingDecisions.invoiceId, invoiceId));
    await mandate(f, { minGrade: "B" });
    await expect(bid(f, invoiceId)).rejects.toThrow(/grade D; your mandate stops at B/);
    await mandate(f, { minGrade: "E", sectors: ["Textiles and apparel"] });
    await expect(bid(f, invoiceId)).rejects.toThrow(/industry/);
    await w.db.update(businesses).set({ industry: "Textiles and apparel" }).where(eq(businesses.id, w.sellerId));
    await bid(f, invoiceId);
  });

  it("a paused mandate stops new bids but an existing bid can still be accepted", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    const b = await bid(f, invoiceId);
    await mandate(f, { status: "paused" });
    await expect(bid(f, invoiceId, 900)).rejects.toThrow(/paused/);
    await acceptBid(w.db, b.id, w.sellerActor, gw, T0);
  });

  it("needs a credit limit on the buyer; a blocked buyer is refused; the limit counts what is already out", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    await w.db.delete(financierBuyerLimits).where(eq(financierBuyerLimits.financierId, f.id));
    await expect(bid(f, invoiceId)).rejects.toThrow(/set a credit limit for this buyer/);
    const fin = { id: f.id, role: "financier", orgRole: "owner", businessId: f.id };
    await setBuyerLimit(w.db, fin, { buyerId: w.buyerId, limit: 10n * L, status: "blocked" });
    await expect(bid(f, invoiceId)).rejects.toThrow(/blocked this buyer/);
    await setBuyerLimit(w.db, fin, { buyerId: w.buyerId, limit: 12n * L });
    const b = await bid(f, invoiceId);
    await acceptBid(w.db, b.id, w.sellerActor, gw, T0); // ₹9L out against a ₹12L limit
    const second = (await w.offered()).invoiceId;
    await expect(bid(f, second)).rejects.toThrow(/over your limit for this buyer/); // ₹9L + ₹9L > ₹12L
    const [row] = await listLimits(w.db, f.id);
    expect(row).toMatchObject({ limit: 12n * L, used: 9n * L, left: 3n * L, status: "active" });
  });

  it("lowering the limit after a bid blocks its acceptance; a lapsed licence does too", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    const b = await bid(f, invoiceId);
    await w.db.update(financierBuyerLimits).set({ limit: 5n * L }).where(eq(financierBuyerLimits.financierId, f.id));
    await expect(acceptBid(w.db, b.id, w.sellerActor, gw, T0)).rejects.toThrow(/limit on this buyer no longer covers/);
    await w.db.update(financierBuyerLimits).set({ limit: 50n * L }).where(eq(financierBuyerLimits.financierId, f.id));
    await w.db.update(financierProfiles).set({ status: "suspended" }).where(eq(financierProfiles.businessId, f.id));
    await expect(acceptBid(w.db, b.id, w.sellerActor, gw, T0)).rejects.toThrow(/can no longer fund/);
  });

  it("a cap per seller limits what is out to one seller across invoices", async () => {
    const f = await w.financier("Capital One", 50n * L);
    await mandate(f, { maxPerSeller: 12n * L });
    const a = (await w.offered()).invoiceId;
    await acceptBid(w.db, (await bid(f, a)).id, w.sellerActor, gw, T0);
    await expect(bid(f, (await w.offered()).invoiceId)).rejects.toThrow(/cap for this seller/);
  });

  it("the payout itself is refused if the financier was suspended after the bid was accepted", async () => {
    const f = await w.financier("Capital One", 50n * L);
    const { invoiceId } = await w.offered();
    const offer = await acceptBid(w.db, (await bid(f, invoiceId)).id, w.sellerActor, gw, T0);
    await prepareAgreements(w.db, offer.id, gw, T0);
    await signInApp(w.db, { offerId: offer.id, actor: w.sellerActor }, T0);
    const d = await requestDisbursement(w.db, offer.id);
    await w.db.update(financierProfiles).set({ status: "suspended" }).where(eq(financierProfiles.businessId, f.id));
    await expect(executeDisbursement(w.db, d.id, gw, T0)).rejects.toThrow(/FINANCIER_NOT_ACTIVE/);
  });
});

describe("the mandate and limits", () => {
  it("only an owner or approver sets them; sensible values only; automatic bidding needs a rate", async () => {
    const f = await w.financier("Capital One", 0n);
    const base = { id: f.id, role: "financier", businessId: f.id };
    await expect(saveMandate(w.db, { ...base, orgRole: "maker" }, MANDATE)).rejects.toThrow(/not allowed/);
    await expect(saveMandate(w.db, { ...base, orgRole: "owner" }, { ...MANDATE, minTicket: 5n * L, maxTicket: L })).rejects.toThrow(/largest ticket/);
    await expect(saveMandate(w.db, { ...base, orgRole: "owner" }, { ...MANDATE, minTenorDays: 90, maxTenorDays: 30 })).rejects.toThrow(/longest tenor/);
    await expect(saveMandate(w.db, { ...base, orgRole: "owner" }, { ...MANDATE, minGrade: "Z" })).rejects.toThrow(/grade/);
    await expect(saveMandate(w.db, { ...base, orgRole: "owner" }, { ...MANDATE, autoBid: true })).rejects.toThrow(/yearly discount/);
    await saveMandate(w.db, { ...base, orgRole: "owner" }, { ...MANDATE, autoBid: true, autoDiscountBps: 1100, autoAdvanceBps: 8000 });
    expect(await mandateOf(w.db, f.id)).toMatchObject({ autoBid: true, autoDiscountBps: 1100, autoAdvanceBps: 8000 });
    await expect(setBuyerLimit(w.db, { ...base, orgRole: "maker" }, { buyerId: w.buyerId, limit: L })).rejects.toThrow(/not allowed/);
  });
});

describe("standing bids", () => {
  it("place bids on every open deal that fits, skip the ones that do not, and never bid twice", async () => {
    const f = await w.financier("Capital One", 50n * L);
    await saveMandate(w.db, { id: "00000000-0000-0000-0000-0000000000f1", role: "financier", orgRole: "owner", businessId: f.id }, { ...MANDATE, maxTicket: 6n * L, autoBid: true, autoDiscountBps: 1100, autoAdvanceBps: 8000 });
    await w.db.update(financierMandates).set({ updatedBy: f.actor.id }).where(eq(financierMandates.businessId, f.id));
    const small = (await w.offered(5_00_000_00n)).invoiceId; // ₹4L advance at 80%: fits
    await w.offered(10_00_000_00n); // ₹8L advance at 80%: above the ₹6L ceiling
    expect(await runAutoBids(w.db, gw, T0)).toBe(1);
    const [mine] = await w.db.select().from(bids).where(eq(bids.invoiceId, small));
    expect(mine).toMatchObject({ financierId: f.id, discountBps: 1100, status: "open" });
    expect(mine.advanceAmount).toBe(4_00_000_00n);
    expect(await runAutoBids(w.db, gw, T0)).toBe(0); // already bidding
  });
  it("a financier whose licence lapsed bids on nothing", async () => {
    const f = await w.financier("Capital One", 50n * L);
    await w.db.update(financierMandates).set({ autoBid: true, autoDiscountBps: 1100, updatedBy: f.actor.id }).where(eq(financierMandates.businessId, f.id));
    await w.offered();
    await w.db.update(financierProfiles).set({ status: "suspended" }).where(eq(financierProfiles.businessId, f.id));
    expect(await runAutoBids(w.db, gw, T0)).toBe(0);
  });
});

describe("the platform's own balance sheet", () => {
  const was = OFFER.platformFunds;
  afterEach(() => { OFFER.platformFunds = was; });
  it("when switched off, invoices make no platform offer and wait for financiers' bids", async () => {
    OFFER.platformFunds = 0;
    await expect(w.offered()).rejects.toThrow(/unfunded/);
    const [inv] = await w.db.select().from(invoices);
    expect(inv.status).toBe("eligible");
    const r = await generateOffer(w.db, inv.id, gw, T0);
    expect(r).toMatchObject({ unfunded: true, awaitingBids: true });
    expect(await w.db.select().from(financingOffers)).toHaveLength(0);
    // a financier's bid still funds it
    const f = await w.financier("Capital One", 50n * L);
    const b = await bid(f, inv.id);
    const offer = await acceptBid(w.db, b.id, w.sellerActor, gw, T0);
    expect(offer.status).toBe("accepted");
  });
});

void acceptOffer; void and;
