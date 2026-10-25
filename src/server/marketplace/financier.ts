// Financiers are institutions. They apply, staff verify the licence, and from then on every bid is checked against the financier's
// own mandate and the credit limit it has given the buyer. Nothing here moves money; marketplace/service.ts does that.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, businesses, financierBuyerLimits, financierMandates, financierProfiles, financingOffers, invoices } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness, notifyStaff } from "../notify";
import { assertCan } from "../permissions";
import { formatMoney } from "../../lib/money";
import { market, PACKS } from "../../lib/countries";
import { createHash } from "node:crypto";
import { docText, financierTerms, FINANCIER_TERMS_VERSION } from "../agreements/templates";

/** The kinds of lender this market licenses, and a label for any stored kind. */
export const institutions = () => market().institutions;
export const institutionLabel = (k: string) => market().institutions[k] ?? Object.values(PACKS).map((x) => x.institutions[k]).find(Boolean) ?? k;
export const GRADES = ["A", "B", "C", "D", "E"] as const;
const STAFF = ["ops", "compliance", "admin"];
const LIVE = ["eligible", "financed", "due", "overdue"] as const; // invoice states in which money is still out or committed
const COUNTRY = /^[A-Z]{2}$/;

export type Actor = { id: string; role: string; orgRole: string; businessId: string | null };
const need = (a: Actor) => { if (!a.businessId || a.role !== "financier") throw new Error("this is for financier companies"); return a.businessId; };
const today = (now: Date) => now.toISOString().slice(0, 10);

export const profileOf = async (db: Database | Tx, businessId: string) => (await db.select().from(financierProfiles).where(eq(financierProfiles.businessId, businessId)))[0];
export const mandateOf = async (db: Database | Tx, businessId: string) => (await db.select().from(financierMandates).where(eq(financierMandates.businessId, businessId)))[0];

export type Application = {
  institutionType: string; countries: string[]; regulator: string; licenceType: string; licenceNumber: string; licenceValidUntil?: string | null;
  licenceDocRef?: string | null; settlementAccount: string; settlementIfsc: string; settlementName: string;
  acceptTerms?: boolean; // must be true to send the application: the participation terms
};
export const financierTermsHash = () => createHash("sha256").update(docText(financierTerms())).digest("hex");

/** Save the application as a draft, or send it to staff. A rejected or info-requested application can be edited and sent again. */
export async function saveApplication(db: Database, actor: Actor, a: Application, submit: boolean, gw: Adapters = gateway, now = new Date()) {
  assertCan(actor, "financier.apply");
  const businessId = need(actor);
  const cur = await profileOf(db, businessId);
  if (cur && !["draft", "info_requested", "rejected"].includes(cur.status)) throw new Error(`your application is ${cur.status.replace("_", " ")} and cannot be edited`);
  const countries = [...new Set(a.countries.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!(a.institutionType in market().institutions)) throw new Error("choose the kind of institution you are");
  if (countries.length === 0 || countries.some((c) => !COUNTRY.test(c))) throw new Error("list the countries you are licensed in, as two-letter codes such as IN or ZM");
  if (submit && !countries.includes(market().code)) throw new Error(`your licence must cover ${market().name}, where this platform operates`);
  for (const [v, m] of [[a.regulator, "the regulator"], [a.licenceType, "the licence type"], [a.licenceNumber, "the licence number"]] as const) if (v.trim().length < 2) throw new Error(`enter ${m}`);
  if (a.licenceValidUntil && !/^\d{4}-\d{2}-\d{2}$/.test(a.licenceValidUntil)) throw new Error("licence expiry must be a date");
  if (submit && a.licenceValidUntil && a.licenceValidUntil < today(now)) throw new Error("that licence has expired");
  if (a.settlementAccount.trim().length < 6 || a.settlementIfsc.trim().length < 4 || a.settlementName.trim().length < 2) throw new Error("enter the account your repayments are paid to");
  if (submit && !(cur?.licenceDocRef || a.licenceDocRef)) throw new Error("attach a copy of the licence");
  if (submit && !a.acceptTerms) throw new Error("read and accept the financier participation terms");

  let verified = false;
  if (submit) verified = (await gw.kyc.verifyBankAccount(a.settlementAccount.trim(), a.settlementIfsc.trim().toUpperCase(), a.settlementName.trim())).nameMatch; // throws when the provider is down: fail closed
  const values = {
    institutionType: a.institutionType, countries, regulator: a.regulator.trim(), licenceType: a.licenceType.trim(), licenceNumber: a.licenceNumber.trim(),
    licenceValidUntil: a.licenceValidUntil || null, licenceDocRef: a.licenceDocRef ?? cur?.licenceDocRef ?? null,
    settlementAccount: a.settlementAccount.trim(), settlementIfsc: a.settlementIfsc.trim().toUpperCase(), settlementName: a.settlementName.trim(), settlementVerified: submit ? verified : false,
    status: submit ? "submitted" : (cur?.status ?? "draft"),
    ...(submit ? { submittedAt: now, note: null, termsVersion: FINANCIER_TERMS_VERSION, termsHash: financierTermsHash(), termsAcceptedAt: now, termsAcceptedBy: actor.id } : {}),
  };
  await db.transaction(async (tx) => {
    if (cur) await tx.update(financierProfiles).set(values).where(eq(financierProfiles.id, cur.id));
    else await tx.insert(financierProfiles).values({ businessId, ...values });
    await tx.insert(auditLog).values({ actorId: actor.id, action: submit ? "financier.apply" : "financier.application_saved", entity: "business", entityId: businessId, after: { countries, licenceNumber: values.licenceNumber } });
  });
  if (submit) {
    const [b] = await db.select({ n: businesses.displayName, l: businesses.legalName }).from(businesses).where(eq(businesses.id, businessId));
    await notifyStaff(db, ["ops", "compliance", "admin"], "financier_application", { name: b.n ?? b.l, licence: values.licenceNumber, link: "/admin/financiers" }, gw, now);
  }
  return { submitted: submit, settlementVerified: verified };
}

export type Review = "approve" | "reject" | "request_info" | "suspend" | "reinstate";

/** Staff decide. Approval needs a verified company, a licence that has not lapsed, and creates a default mandate to adjust. */
export async function reviewApplication(db: Database, staff: { id: string; role: string }, businessId: string, decision: Review, note: string, gw: Adapters = gateway, now = new Date()) {
  if (!STAFF.includes(staff.role)) throw new Error("forbidden");
  const p = await profileOf(db, businessId);
  if (!p) throw new Error("this company has not applied");
  if (decision !== "approve" && !note.trim()) throw new Error("say why in a note");
  const from: Record<Review, string[]> = { approve: ["submitted"], reject: ["submitted", "info_requested"], request_info: ["submitted"], suspend: ["approved"], reinstate: ["suspended"] };
  if (!from[decision].includes(p.status)) throw new Error(`cannot ${decision.replace("_", " ")} an application that is ${p.status.replace("_", " ")}`);
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (decision === "approve" || decision === "reinstate") {
    if (b.kybStatus !== "approved") throw new Error("the company's own verification (KYB) is not approved yet");
    if (p.licenceValidUntil && p.licenceValidUntil < today(now)) throw new Error("the licence has expired");
  }
  const status = { approve: "approved", reinstate: "approved", reject: "rejected", request_info: "info_requested", suspend: "suspended" }[decision];
  await db.transaction(async (tx) => {
    await tx.update(financierProfiles).set({ status, note: note.trim() || null, reviewedBy: staff.id, reviewedAt: now }).where(eq(financierProfiles.id, p.id));
    if (decision === "approve") await tx.insert(financierMandates).values({ businessId, updatedBy: staff.id }).onConflictDoNothing();
    await tx.insert(auditLog).values({ actorId: staff.id, action: `financier.${decision}`, entity: "business", entityId: businessId, before: { status: p.status }, after: { status, note } });
  });
  await notifyBusiness(db, businessId, "financier_decision", { status: status.replace("_", " "), note: note.trim() }, gw, now);
  return { status };
}

/**
 * Can this financier fund an invoice raised by a seller in `country` right now? Approved by staff, licence not lapsed, licensed in that country.
 * Called when it bids, when a bid is accepted and when the payout is made, so a licence that lapses stops new money straight away.
 */
export async function assertActiveFinancier(db: Database | Tx, businessId: string, country: string | null = market().code, now = new Date()) {
  const p = await profileOf(db, businessId);
  if (!p) throw new Error("complete your financier application first");
  if (p.status !== "approved") throw new Error(p.status === "suspended" ? "your financier access is suspended" : "your financier application has not been approved yet");
  if (p.licenceValidUntil && p.licenceValidUntil < today(now)) throw new Error("your licence has expired. Send the renewed licence to our team");
  if (country && !p.countries.includes(country)) throw new Error(`you are not licensed to fund in ${country}`);
  return p;
}

export type MandateInput = {
  status: "active" | "paused"; minTicket: bigint; maxTicket: bigint | null; minTenorDays: number; maxTenorDays: number; minGrade: string;
  maxPerSeller: bigint | null; sectors: string[]; autoBid: boolean; autoDiscountBps: number | null; autoAdvanceBps: number | null;
};

export async function saveMandate(db: Database, actor: Actor, m: MandateInput) {
  assertCan(actor, "mandate.manage");
  const businessId = need(actor);
  await assertActiveFinancier(db, businessId, null);
  if (m.minTicket < 0n || (m.maxTicket !== null && m.maxTicket < m.minTicket)) throw new Error("the largest ticket must be at least the smallest");
  if (!Number.isInteger(m.minTenorDays) || !Number.isInteger(m.maxTenorDays) || m.minTenorDays < 1 || m.maxTenorDays < m.minTenorDays) throw new Error("the longest tenor must be at least the shortest");
  if (!GRADES.includes(m.minGrade as never)) throw new Error("choose a grade from A to E");
  if (m.maxPerSeller !== null && m.maxPerSeller <= 0n) throw new Error("the per-seller cap must be more than zero");
  if (m.autoBid) {
    if (!m.autoDiscountBps || m.autoDiscountBps < 100 || m.autoDiscountBps > 6000) throw new Error("automatic bidding needs the yearly discount you will bid");
    if (m.autoAdvanceBps !== null && (m.autoAdvanceBps < 1 || m.autoAdvanceBps > 10_000)) throw new Error("the advance percentage must be between 1 and 100");
  }
  const values = { ...m, sectors: m.sectors.map((s) => s.trim()).filter(Boolean), autoDiscountBps: m.autoBid ? m.autoDiscountBps : null, autoAdvanceBps: m.autoBid ? m.autoAdvanceBps : null, updatedBy: actor.id, updatedAt: new Date() };
  await db.transaction(async (tx) => {
    const cur = await mandateOf(tx, businessId);
    if (cur) await tx.update(financierMandates).set(values).where(eq(financierMandates.id, cur.id));
    else await tx.insert(financierMandates).values({ businessId, ...values });
    await tx.insert(auditLog).values({ actorId: actor.id, action: "financier.mandate", entity: "business", entityId: businessId, before: cur ? { autoBid: cur.autoBid, minGrade: cur.minGrade } : null, after: { autoBid: m.autoBid, minGrade: m.minGrade, status: m.status } });
  });
}

/** What the financier has out to a buyer: advances accepted but not yet repaid (including ones accepted and waiting for payout). */
export async function exposureToBuyer(db: Database | Tx, financierId: string, buyerId: string) {
  const [r] = await db.select({ v: sql<string>`coalesce(sum(${financingOffers.advanceAmount}), 0)` }).from(financingOffers).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(financingOffers.financierId, financierId), eq(financingOffers.status, "accepted"), eq(invoices.buyerId, buyerId), inArray(invoices.status, [...LIVE])));
  return BigInt(r.v);
}
export async function exposureToSeller(db: Database | Tx, financierId: string, sellerId: string) {
  const [r] = await db.select({ v: sql<string>`coalesce(sum(${financingOffers.advanceAmount}), 0)` }).from(financingOffers).innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .where(and(eq(financingOffers.financierId, financierId), eq(financingOffers.status, "accepted"), eq(invoices.sellerId, sellerId), inArray(invoices.status, [...LIVE])));
  return BigInt(r.v);
}

export async function setBuyerLimit(db: Database, actor: Actor, p: { buyerId: string; limit: bigint; status?: "active" | "blocked" }) {
  assertCan(actor, "mandate.manage");
  const businessId = need(actor);
  if (p.limit < 0n) throw new Error("the limit cannot be negative");
  const [b] = await db.select({ id: businesses.id, kind: businesses.kind }).from(businesses).where(eq(businesses.id, p.buyerId));
  if (!b) throw new Error("buyer not found");
  const status = p.status ?? "active";
  await db.transaction(async (tx) => {
    await tx.insert(financierBuyerLimits).values({ financierId: businessId, buyerId: p.buyerId, limit: p.limit, status, updatedBy: actor.id })
      .onConflictDoUpdate({ target: [financierBuyerLimits.financierId, financierBuyerLimits.buyerId], set: { limit: p.limit, status, updatedBy: actor.id, updatedAt: new Date() } });
    await tx.insert(auditLog).values({ actorId: actor.id, action: "financier.buyer_limit", entity: "business", entityId: businessId, after: { buyerId: p.buyerId, limit: p.limit.toString(), status } });
  });
}

/** The limits this financier has set, with what it has out against each and what is left. */
export async function listLimits(db: Database, financierId: string) {
  const rows = await db.select({ l: financierBuyerLimits, name: businesses.legalName, gstin: businesses.gstin }).from(financierBuyerLimits).innerJoin(businesses, eq(businesses.id, financierBuyerLimits.buyerId)).where(eq(financierBuyerLimits.financierId, financierId));
  return Promise.all(rows.map(async (r) => {
    const used = await exposureToBuyer(db, financierId, r.l.buyerId);
    return { buyerId: r.l.buyerId, name: r.name, gstin: r.gstin, limit: r.l.limit, status: r.l.status, used, left: r.l.status === "blocked" ? 0n : r.l.limit > used ? r.l.limit - used : 0n };
  }));
}

/** Everything a bid must satisfy besides having the cash. Throws the reason in plain words. Run inside the bid's transaction. */
export async function assertWithinMandate(tx: Tx, financierId: string, deal: { buyerId: string; sellerId: string; grade: string; advance: bigint; tenorDays: number; industry: string | null }) {
  const m = await mandateOf(tx, financierId);
  if (!m) throw new Error("set up your mandate first");
  if (m.status !== "active") throw new Error("your mandate is paused");
  if (deal.advance < m.minTicket) throw new Error(`this is below your smallest ticket (${formatMoney(m.minTicket)})`);
  if (m.maxTicket !== null && deal.advance > m.maxTicket) throw new Error(`this is above your largest ticket (${formatMoney(m.maxTicket)})`);
  if (deal.tenorDays < m.minTenorDays || deal.tenorDays > m.maxTenorDays) throw new Error(`the tenor (${deal.tenorDays} days) is outside your mandate (${m.minTenorDays} to ${m.maxTenorDays} days)`);
  if (GRADES.indexOf(deal.grade as never) > GRADES.indexOf(m.minGrade as never)) throw new Error(`this invoice is grade ${deal.grade}; your mandate stops at ${m.minGrade}`);
  if (m.sectors.length > 0 && !(deal.industry && m.sectors.includes(deal.industry))) throw new Error("the seller's industry is outside your mandate");
  if (m.maxPerSeller !== null && (await exposureToSeller(tx, financierId, deal.sellerId)) + deal.advance > m.maxPerSeller) throw new Error("this would take you over your cap for this seller");
  const [lim] = await tx.select().from(financierBuyerLimits).where(and(eq(financierBuyerLimits.financierId, financierId), eq(financierBuyerLimits.buyerId, deal.buyerId)));
  if (!lim) throw new Error("set a credit limit for this buyer before bidding on its invoices");
  if (lim.status === "blocked") throw new Error("you have blocked this buyer");
  if ((await exposureToBuyer(tx, financierId, deal.buyerId)) + deal.advance > lim.limit) throw new Error("this would take you over your limit for this buyer");
  return m;
}
