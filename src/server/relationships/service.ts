import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { isBlacklisted } from "../fraud/service";
import { auditLog, businesses, buyerInvites, buyerSellerRelationships } from "../db/schema";

/** How an invitation names an overseas buyer, which has no GSTIN. */
export const foreignKey = (country: string, taxId: string) => `FOREIGN:${country.toUpperCase()}:${taxId.trim().toUpperCase()}`;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

async function statusOf(db: Database, id: string) {
  const [b] = await db.select({ s: businesses.kybStatus }).from(businesses).where(eq(businesses.id, id));
  return b?.s;
}

/**
 * Seller names a buyer by GSTIN. Verified buyer -> relationship now.
 * Unknown/unverified buyer -> "invite your buyer" record, linked automatically once they're approved.
 */
export async function linkBuyer(
  db: Database,
  p: { sellerId: string; buyerGstin: string; buyerEmail: string; creditTermsDays?: number; maxExposure?: bigint },
) {
  const gstin = p.buyerGstin.trim().toUpperCase();
  if (!GSTIN.test(gstin)) throw new Error("invalid GSTIN");
  if ((await statusOf(db, p.sellerId)) !== "approved") throw new Error("seller KYB not approved");

  const [buyer] = await db.select().from(businesses).where(eq(businesses.gstin, gstin));
  if (buyer?.id === p.sellerId) throw new Error("seller and buyer cannot be the same business");

  if (buyer?.kybStatus === "approved") {
    await db.insert(buyerSellerRelationships).values({
      buyerId: buyer.id, sellerId: p.sellerId,
      creditTermsDays: p.creditTermsDays ?? 60, maxExposure: p.maxExposure,
    }).onConflictDoNothing();
    await db.insert(auditLog).values({ action: "relationship.link", entity: "business", entityId: p.sellerId, after: { buyerId: buyer.id } });
    return { linked: true as const, buyerId: buyer.id };
  }
  await db.insert(buyerInvites).values({
    sellerId: p.sellerId, buyerGstin: gstin, buyerEmail: p.buyerEmail, creditTermsDays: p.creditTermsDays ?? 60,
  }).onConflictDoNothing();
  return { linked: false as const, invited: true as const };
}

/** Call whenever a business becomes approved: turns pending invites for its GSTIN into relationships. Idempotent. */
export async function resolveInvites(db: Database, businessId: string) {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const key = b?.gstin ?? (b?.country && b.taxId ? foreignKey(b.country, b.taxId) : null);
  if (!b || !key || b.kybStatus !== "approved") return 0;
  const pending = await db.select().from(buyerInvites)
    .where(and(eq(buyerInvites.buyerGstin, key), eq(buyerInvites.status, "pending")));
  for (const inv of pending) {
    if (inv.sellerId === b.id) continue;
    await db.insert(buyerSellerRelationships).values({
      buyerId: b.id, sellerId: inv.sellerId, creditTermsDays: inv.creditTermsDays,
    }).onConflictDoNothing();
    await db.update(buyerInvites).set({ status: "linked" }).where(eq(buyerInvites.id, inv.id));
  }
  return pending.length;
}

/**
 * Gate for Module 3. Throws with a code the UI maps to the right screen:
 * BUYER_NOT_VERIFIED -> "invite your buyer" flow instead of invoice upload.
 */
export async function assertCanRaiseInvoice(db: Database, sellerId: string, buyerId: string) {
  if (sellerId === buyerId) throw new Error("SELF_DEALING");
  if ((await isBlacklisted(db, sellerId)) || (await isBlacklisted(db, buyerId))) throw new Error("BLACKLISTED");
  if ((await statusOf(db, sellerId)) !== "approved") throw new Error("SELLER_NOT_VERIFIED");
  if ((await statusOf(db, buyerId)) !== "approved") throw new Error("BUYER_NOT_VERIFIED");
  const [rel] = await db.select().from(buyerSellerRelationships).where(and(
    eq(buyerSellerRelationships.buyerId, buyerId), eq(buyerSellerRelationships.sellerId, sellerId),
  ));
  if (!rel) throw new Error("NO_RELATIONSHIP");
  return rel;
}
