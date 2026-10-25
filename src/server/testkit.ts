import { eq } from "drizzle-orm";
import { businesses, financierBuyerLimits, financierMandates, financierProfiles, invoices, memberships, users } from "./db/schema";
import { submitKyb, submitLightKyb } from "./kyb/service";
import { linkBuyer } from "./relationships/service";
import { createInvoice } from "./invoices/service";
import { recordConsent, underwriteInvoice } from "./underwriting/service";
import { acceptOffer, generateOffer } from "./offers/service";
import { mock } from "./integrations/mock";
import { testDb } from "./testdb";
import { prepareAgreements, signInApp } from "./agreements/service";
import { executeDisbursement, fundEscrow, requestDisbursement } from "./disbursements/service";
import { financingOffers, virtualAccounts } from "./db/schema";
import { recordFunding } from "./marketplace/service";

export const T0 = new Date("2026-10-06T00:00:00Z");
export const gw = { ...mock, bureau: { pull: async () => ({ score: 780, noHit: false }) } };

/** A verified seller + buyer (with one login each), linked, with bureau consent. Tests only. */
export async function world() {
  const db = await testDb();
  const sellerId = (await db.insert(businesses).values({ legalName: "Seller Co", entityType: "pvt_ltd" }).returning())[0].id;
  const buyerId = (await db.insert(businesses).values({ legalName: "Big Corp", entityType: "pvt_ltd" }).returning())[0].id;
  await submitKyb(db, {
    businessId: sellerId, pan: "ABCDE1234F", gstin: "27AAAAA1111A1Z5", ubos: [{ name: "Ravi", shareholdingBps: 10000 }],
    bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Seller Co" },
  });
  await submitLightKyb(db, { businessId: buyerId, gstin: "29BBBBB2222B1Z5", pan: "BCDEF2345G" });
  await linkBuyer(db, { sellerId, buyerGstin: "29BBBBB2222B1Z5", buyerEmail: "ap@big.com" });
  await recordConsent(db, { businessId: sellerId, text: "ok" });
  await recordConsent(db, { businessId: buyerId, text: "ok" });
  const [su, bu] = await db.insert(users).values([
    { name: "Seller", email: "s@seller.com", role: "seller", businessId: sellerId },
    { name: "AP", email: "ap@big.com", role: "buyer", businessId: buyerId },
  ]).returning();
  await db.insert(memberships).values([{ userId: su.id, businessId: sellerId, orgRole: "owner" }, { userId: bu.id, businessId: buyerId, orgRole: "owner" }]);
  await db.update(businesses).set({ kind: "seller" }).where(eq(businesses.id, sellerId));
  await db.update(businesses).set({ kind: "buyer" }).where(eq(businesses.id, buyerId));
  const sellerActor = { id: su.id, email: su.email, role: "seller", businessId: sellerId };
  let n = 0;
  /** Invoice -> eligible -> underwritten -> offered. Returns the open offer and its invoice. */
  const offered = async (amount = 10_00_000_00n) => {
    const { id } = await createInvoice(db, {
      sellerId, buyerId, invoiceNumber: `INV-${++n}`, invoiceDate: "2026-09-25", dueDate: "2026-11-20",
      amount, contentHash: `h${n}`, irn: `IRN-OK-${n}`,
    }, mock, T0);
    await db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id));
    await underwriteInvoice(db, id, gw, T0);
    const o = await generateOffer(db, id, gw, T0);
    if (o.unfunded) throw new Error("unfunded");
    return { offerId: o.offer.id, invoiceId: id };
  };
  /** The same, then accepted. Returns the accepted offer id. */
  const acceptedOffer = async (amount?: bigint) => {
    const { offerId } = await offered(amount);
    await acceptOffer(db, offerId, sellerActor, T0);
    return offerId;
  };
  /** Accepted -> signed -> escrow funded -> paid out at T0. Returns what a test needs to simulate the buyer paying. */
  const financed = async (amount?: bigint) => {
    const offer = await acceptedOffer(amount);
    await prepareAgreements(db, offer, gw, T0);
    await signInApp(db, { offerId: offer, actor: sellerActor }, T0);
    await fundEscrow(db, { amount: 50_00_000_00n, ref: `fund-${offer}`, staffId: "00000000-0000-0000-0000-0000000000a1", staffRole: "ops" });
    const d = await requestDisbursement(db, offer);
    await executeDisbursement(db, d.id, gw, T0);
    const [o] = await db.select().from(financingOffers).where(eq(financingOffers.id, offer));
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, o.invoiceId)); // THIS offer's invoice, not the first one
    const [va] = await db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, inv.id));
    return { offer, disbursementId: d.id, invoiceId: inv.id, account: va.accountNumber };
  };
  /** A verified financier company with one login. Optionally funded through the normal staff flow. */
  const financier = async (name = "Capital One", fund = 0n) => {
    const [b] = await db.insert(businesses).values({ legalName: name, entityType: "nbfc", kybStatus: "approved" }).returning();
    const [u] = await db.insert(users).values({ name, email: `${b.id}@fin.com`, role: "financier", businessId: b.id }).returning();
    await db.insert(memberships).values({ userId: u.id, businessId: b.id, orgRole: "owner" });
    await db.update(businesses).set({ kind: "financier" }).where(eq(businesses.id, b.id));
    // Approved by staff, licensed in India, an open mandate and a generous limit on the buyer: tests tighten what they need to test.
    await db.insert(financierProfiles).values({ businessId: b.id, institutionType: "nbfc_factor", countries: ["IN"], regulator: "RBI", licenceType: "NBFC-Factor", licenceNumber: `N-${b.id.slice(0, 6)}`, licenceValidUntil: "2030-12-31", settlementAccount: "123456789012", settlementIfsc: "HDFC0001234", settlementName: name, settlementVerified: true, status: "approved" });
    await db.insert(financierMandates).values({ businessId: b.id, minGrade: "E", maxTicket: null });
    await db.insert(financierBuyerLimits).values({ financierId: b.id, buyerId, limit: 1_000_00_00_000_00n });
    if (fund > 0n) await recordFunding(db, { financierId: b.id, amount: fund, ref: `seed-${b.id}`, staffId: "00000000-0000-0000-0000-0000000000a1", staffRole: "ops" });
    return { id: b.id, actor: { id: u.id, role: "financier", businessId: b.id } };
  };
  return { db, sellerId, buyerId, sellerActor, buyerUserId: bu.id, offered, acceptedOffer, financed, financier };
}
