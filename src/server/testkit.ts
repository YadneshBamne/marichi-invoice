import { eq } from "drizzle-orm";
import { businesses, invoices, users } from "./db/schema";
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
  return { db, sellerId, buyerId, sellerActor, buyerUserId: bu.id, offered, acceptedOffer, financed };
}
