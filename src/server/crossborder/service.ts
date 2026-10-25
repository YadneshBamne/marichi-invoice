// Cross-border financing: export invoices raised on overseas buyers, in the currency the seller invoices in.
// Design: the invoice's `amount` is always rupees (the foreign amount converted at a rate locked on upload, with a safety buffer),
// so offers, disbursement, collections and the ledger work unchanged. What is new here is the overseas buyer's verification, the
// locked rate and its paperwork, a tighter advance, and converting a foreign-currency receipt before it enters the normal waterfall.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, buyerInvites, buyerSellerRelationships, foreignReceipts, invoiceCollections, invoices, virtualAccounts } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { createInvoice } from "../invoices/service";
import { KYB_AML_RULE, openCase } from "../fraud/service";
import { foreignKey } from "../relationships/service";
export { foreignKey };
import { recordIncomingPayment } from "../collections/service";
import { notifyBusiness } from "../notify";

import { CROSS } from "./rules";
import { market } from "../../lib/countries";
export { CROSS };
const COUNTRY = /^[A-Z]{2}$/;
const PURPOSE = /^P\d{4}$/;

/** Export financing follows Indian rules (shipping bill, FEMA purpose codes, bank conversion), so it runs only in the Indian market for now. */
function assertSupported() { if (market().code !== "IN") throw new Error(`export financing is not available in ${market().name} yet`); }

function checkCountry(country: string) {
  assertSupported();
  const c = country.trim().toUpperCase();
  if (!COUNTRY.test(c) || c === market().code) throw new Error(`choose the buyer's country (not ${market().name})`);
  if (CROSS.blockedCountries.includes(c)) throw new Error("we cannot finance invoices on buyers in that country");
  return c;
}

/** Rupees per unit, micro, after the safety buffer. This is the rate locked on the invoice. */
export async function lockRate(gw: Adapters, currency: string) {
  if (!CROSS.currencies.includes(currency)) throw new Error(`we finance invoices in ${CROSS.currencies.join(", ")}`);
  const { midMicro } = await gw.fx.rate(currency);
  return { midMicro, lockedMicro: (midMicro * BigInt(10_000 - CROSS.fxBufferBps)) / 10_000n };
}
/** One minor unit (a cent) is 1/100 of a unit, and a paisa is 1/100 of a rupee, so paise = cents x rupees-per-unit. */
export const toPaise = (foreignMinor: bigint, rateMicro: bigint) => (foreignMinor * rateMicro) / 1_000_000n;

/** The seller names an overseas buyer. Verified already => linked now; otherwise an invitation that links when the buyer is verified. */
export async function linkForeignBuyer(db: Database, p: { sellerId: string; country: string; taxId: string; buyerEmail: string; creditTermsDays?: number }) {
  const country = checkCountry(p.country);
  const taxId = p.taxId.trim().toUpperCase();
  if (taxId.length < 4) throw new Error("enter the buyer's tax or registration number");
  const [seller] = await db.select().from(businesses).where(eq(businesses.id, p.sellerId));
  if (seller?.kybStatus !== "approved") throw new Error("seller KYB not approved");
  const [buyer] = await db.select().from(businesses).where(and(eq(businesses.country, country), eq(businesses.taxId, taxId)));
  if (buyer?.kybStatus === "approved") {
    await db.insert(buyerSellerRelationships).values({ buyerId: buyer.id, sellerId: p.sellerId, creditTermsDays: p.creditTermsDays ?? 60 }).onConflictDoNothing();
    await db.insert(auditLog).values({ action: "relationship.link", entity: "business", entityId: p.sellerId, after: { buyerId: buyer.id, country } });
    return { linked: true as const, buyerId: buyer.id };
  }
  await db.insert(buyerInvites).values({ sellerId: p.sellerId, buyerGstin: foreignKey(country, taxId), buyerEmail: p.buyerEmail, creditTermsDays: p.creditTermsDays ?? 60 }).onConflictDoNothing();
  return { linked: false as const, invited: true as const };
}

/** An overseas company's own verification: country check, registration number, sanctions screening. A hit goes to compliance. */
export async function submitForeignKyb(db: Database, p: { businessId: string; country: string; taxId: string }, gw: Adapters = gateway) {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, p.businessId));
  if (!biz) throw new Error("business not found");
  if (!["draft", "info_requested", "rejected"].includes(biz.kybStatus)) throw new Error(`cannot submit KYB from status ${biz.kybStatus}`);
  const country = checkCountry(p.country);
  const taxId = p.taxId.trim().toUpperCase();
  if (taxId.length < 4) throw new Error("enter your tax or registration number");
  const aml = await gw.kyc.screenAml(biz.legalName); // throws => fail closed
  const status = aml.hit ? ("under_review" as const) : ("approved" as const);
  const note = aml.hit ? "sanctions/PEP screening hit" : null;
  await db.transaction(async (tx) => {
    await tx.update(businesses).set({ country, taxId, kybLevel: "light", kybStatus: status, kybNote: note }).where(eq(businesses.id, biz.id));
    if (aml.hit) await openCase(tx, { entityType: "business", entityId: biz.id, rule: KYB_AML_RULE, subjectBusinessId: biz.id, details: { screenedNames: [biz.legalName], country } });
    await tx.insert(auditLog).values({ action: "kyb.submit_foreign", entity: "business", entityId: biz.id, before: { status: biz.kybStatus }, after: { status, country } });
    if (status === "approved") await resolveForeignInvites(tx, biz.id, country, taxId);
  });
  await notifyBusiness(db, biz.id, "kyb_decision", { status: status.replaceAll("_", " "), note: note ?? "" }, gw);
  return { status };
}

/** Turn waiting invitations for this overseas buyer into relationships. Staff approval of a held buyer calls resolveInvites, so cover that too. */
async function resolveForeignInvites(tx: Pick<Database, "select" | "insert" | "update">, businessId: string, country: string, taxId: string) {
  const pending = await tx.select().from(buyerInvites).where(and(eq(buyerInvites.buyerGstin, foreignKey(country, taxId)), eq(buyerInvites.status, "pending")));
  for (const inv of pending) {
    await tx.insert(buyerSellerRelationships).values({ buyerId: businessId, sellerId: inv.sellerId, creditTermsDays: inv.creditTermsDays }).onConflictDoNothing();
    await tx.update(buyerInvites).set({ status: "linked" }).where(eq(buyerInvites.id, inv.id));
  }
}
export const resolveForeignInvitesFor = async (db: Database, businessId: string) => {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (b?.country && b.taxId && b.kybStatus === "approved") await resolveForeignInvites(db, b.id, b.country, b.taxId);
};

export type ExportInvoice = {
  sellerId: string; buyerId: string; invoiceNumber: string; invoiceDate: string; dueDate: string;
  currency: string; foreignAmount: bigint; // minor units
  shippingBill?: string; purposeCode?: string; poReference?: string; contentHash: string; documentRef?: string;
};

/** Capture an export invoice. The rate is locked now and stored with the invoice; the rupee amount goes through the usual checks. */
export async function createExportInvoice(db: Database, p: ExportInvoice, gw: Adapters = gateway, now = new Date()) {
  assertSupported();
  const [buyer] = await db.select().from(businesses).where(eq(businesses.id, p.buyerId));
  if (!buyer?.country) throw new Error("this buyer is not an overseas company");
  checkCountry(buyer.country);
  if (p.foreignAmount <= 0n) throw new Error("enter the invoice amount");
  const shippingBill = p.shippingBill?.trim() || undefined, purposeCode = p.purposeCode?.trim().toUpperCase() || undefined;
  if (!shippingBill && !purposeCode) throw new Error("give the shipping bill number (goods) or the purpose code (services)");
  if (purposeCode && !PURPOSE.test(purposeCode)) throw new Error("the purpose code looks like P0102");
  const { lockedMicro } = await lockRate(gw, p.currency);
  const inv = await createInvoice(db, {
    sellerId: p.sellerId, buyerId: p.buyerId, invoiceNumber: p.invoiceNumber, invoiceDate: p.invoiceDate, dueDate: p.dueDate,
    amount: toPaise(p.foreignAmount, lockedMicro), poReference: p.poReference, contentHash: p.contentHash, documentRef: p.documentRef,
    currency: p.currency, foreignAmount: p.foreignAmount, fxRateMicro: lockedMicro, shippingBill, purposeCode,
  }, gw, now);
  return { ...inv, lockedMicro };
}

/**
 * A buyer's payment arrived in a foreign currency. Convert at today's rate less the bank's spread, keep the record, and feed the rupees
 * into the normal waterfall. A shortfall from a weaker rupee stays with the seller (recourse); a surplus goes back to them.
 */
export async function recordForeignPayment(db: Database, p: { accountNumber: string; currency: string; foreignAmount: bigint; utr: string; receivedAt: Date }, gw: Adapters = gateway, now = new Date()) {
  assertSupported();
  if (p.foreignAmount <= 0n) throw new Error("amount must be positive");
  const [seen] = await db.select({ id: foreignReceipts.id }).from(foreignReceipts).where(eq(foreignReceipts.utr, p.utr));
  if (seen) return { status: "replayed" as const };
  const [va] = await db.select().from(virtualAccounts).where(eq(virtualAccounts.accountNumber, p.accountNumber));
  const [inv] = va ? await db.select().from(invoices).where(eq(invoices.id, va.invoiceId)) : [];
  if (!inv) throw new Error("unknown collection account");
  if (inv.currency !== p.currency) throw new Error(`this invoice is in ${inv.currency}, not ${p.currency}`);
  const { midMicro } = await gw.fx.rate(p.currency);
  const rateMicro = (midMicro * BigInt(10_000 - CROSS.settleSpreadBps)) / 10_000n;
  const inr = toPaise(p.foreignAmount, rateMicro);
  if (inr <= 0n) throw new Error("amount too small to convert");
  await db.insert(foreignReceipts).values({ utr: p.utr, invoiceId: inv.id, currency: p.currency, foreignAmount: p.foreignAmount, rateMicro, inrAmount: inr, receivedAt: p.receivedAt }).onConflictDoNothing();
  const r = await recordIncomingPayment(db, { accountNumber: p.accountNumber, amount: inr, utr: p.utr, receivedAt: p.receivedAt }, gw, now);
  return { status: "converted" as const, inr, rateMicro, result: r };
}

/** What the book has outstanding in foreign currency, by currency and country: the exposure treasury has to watch. */
export async function exposure(db: Database) {
  const rows = await db.select({ currency: invoices.currency, country: businesses.country, foreign: invoices.foreignAmount, locked: invoices.fxRateMicro, principal: invoiceCollections.principal }).from(invoiceCollections)
    .innerJoin(invoices, eq(invoices.id, invoiceCollections.invoiceId)).innerJoin(businesses, eq(businesses.id, invoices.buyerId))
    .where(and(isNull(invoiceCollections.closedAt), sql`${invoices.currency} <> 'INR'`));
  const by = new Map<string, { currency: string; country: string; invoices: number; foreign: bigint; principal: bigint }>();
  for (const r of rows) {
    const k = `${r.currency}:${r.country}`;
    const e = by.get(k) ?? { currency: r.currency, country: r.country ?? "?", invoices: 0, foreign: 0n, principal: 0n };
    e.invoices++; e.foreign += r.foreign ?? 0n; e.principal += r.principal;
    by.set(k, e);
  }
  return [...by.values()].sort((a, b) => Number(b.principal - a.principal));
}

export async function foreignBuyers(db: Database) {
  return db.select({ id: businesses.id, name: businesses.legalName, country: businesses.country, taxId: businesses.taxId, status: businesses.kybStatus }).from(businesses).where(sql`${businesses.country} is not null`);
}
