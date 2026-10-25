// The Key Facts sheet: a one-page, plain-language summary of what an offer costs, shown before the seller accepts and kept as a record
// that it was read. It is generated from the same numbers that go into the Invoice Schedule, so the two can never disagree.
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agreements, auditLog, businesses, financingOffers, invoices, users } from "../db/schema";
import { COLLECTIONS } from "../collections/waterfall";
import { describeOffer } from "../offers/pricing";
import { putGenerated } from "../vault";
import { termsFor } from "./country";
import { renderPdf } from "./pdf";
import { keyFacts, PLATFORM, TEMPLATE_VERSION, type Party } from "./templates";

/** The financier that owns the receivable if this offer is accepted: the bidding financier, or the platform's own balance sheet. */
export async function financierFor(db: Database, offer: { financierId: string | null }): Promise<Party> {
  if (!offer.financierId) return PLATFORM;
  const [b] = await db.select({ n: businesses.legalName }).from(businesses).where(eq(businesses.id, offer.financierId));
  return { legalName: b?.n ?? "Financier", platform: false };
}

/** Make the Key Facts sheet for an offer if there is not one yet. Safe to call any number of times. */
export async function ensureKeyFacts(db: Database, offerId: string, now = new Date()) {
  const [have] = await db.select().from(agreements).where(and(eq(agreements.offerId, offerId), eq(agreements.kind, "key_facts")));
  if (have) return have;
  const [offer] = await db.select().from(financingOffers).where(eq(financingOffers.id, offerId));
  if (!offer) throw new Error("offer not found");
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, offer.invoiceId));
  const [[seller], [buyer]] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, inv.sellerId)),
    db.select().from(businesses).where(eq(businesses.id, inv.buyerId)),
  ]);
  const doc = keyFacts({
    seller, buyer, financier: await financierFor(db, offer), country: termsFor(seller.country),
    invoice: { invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, amount: inv.amount },
    offer: { id: offer.id, advanceAmount: offer.advanceAmount, feeAmount: offer.feeAmount, discountBps: offer.discountBps, tenorDays: offer.tenorDays, expectedDiscount: offer.expectedDiscount, recourse: offer.recourse, expiresAt: offer.expiresAt },
    effectiveAprBps: describeOffer(offer).effectiveAprBps, penalBps: COLLECTIONS.penalBps, graceDays: COLLECTIONS.graceDays, now,
  });
  const { ref, hash } = await putGenerated(await renderPdf(doc, { footer: `Marichi Labs  key facts  ${TEMPLATE_VERSION}` }));
  await db.insert(agreements).values({ businessId: seller.id, offerId, kind: "key_facts", documentRef: ref, documentHash: hash, status: "sent", sentAt: now }).onConflictDoNothing();
  return (await db.select().from(agreements).where(and(eq(agreements.offerId, offerId), eq(agreements.kind, "key_facts"))))[0];
}

/** Record that a named person read the sheet and accepted the offer on it. Replays change nothing. */
export async function acknowledgeKeyFacts(db: Database, offerId: string, actorId: string, now = new Date()) {
  const kf = await ensureKeyFacts(db, offerId, now);
  if (kf.status === "signed") return kf;
  const [u] = await db.select({ e: users.email }).from(users).where(eq(users.id, actorId));
  const [row] = await db.update(agreements).set({ status: "signed", signedAt: now, signedBy: actorId, signedByEmail: u?.e }).where(and(eq(agreements.id, kf.id), eq(agreements.status, "sent"))).returning();
  if (row) await db.insert(auditLog).values({ actorId, action: "keyfacts.acknowledged", entity: "offer", entityId: offerId, after: { hash: kf.documentHash } });
  return row ?? kf;
}
