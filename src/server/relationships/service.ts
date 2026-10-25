import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { isBlacklisted, KYB_AML_RULE, openCase } from "../fraud/service";
import { auditLog, businesses, buyerInvites, buyerSellerRelationships, memberships, users } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";

/** How an invitation names an overseas buyer, which has no GSTIN. */
export const foreignKey = (country: string, taxId: string) => `FOREIGN:${country.toUpperCase()}:${taxId.trim().toUpperCase()}`;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

async function statusOf(db: Database, id: string) {
  const [b] = await db.select({ s: businesses.kybStatus }).from(businesses).where(eq(businesses.id, id));
  return b?.s;
}

/** Mailboxes anyone can open. A buyer contact on one of these is allowed, but never counts as "someone at the seller's company". */
const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "yahoo.co.in", "outlook.com", "hotmail.com", "live.com", "rediffmail.com", "proton.me", "protonmail.com", "icloud.com"]);

/** The person who confirms a supplier's invoices must be at the buyer. A supplier confirming its own invoices defeats the whole control. */
async function assertContactIsNotSeller(db: Database, sellerId: string, email: string) {
  const own = await db.select({ e: users.email }).from(users).where(eq(users.businessId, sellerId));
  const viaMembership = await db.select({ e: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.businessId, sellerId));
  const mine = [...own, ...viaMembership].map((u) => u.e.toLowerCase());
  const domain = email.split("@")[1];
  if (mine.includes(email) || (!FREE_MAIL.has(domain) && mine.some((m) => m.endsWith(`@${domain}`)))) {
    throw new Error("the buyer's contact must be someone at the buyer, not at your own company");
  }
}

/**
 * Seller names a buyer by GSTIN and gives the email of the person there who confirms invoices.
 *  - A buyer we already verified: linked now.
 *  - A buyer we have never seen: we create it as a pending buyer (sanctions-screened), and link it now. It is verified when its
 *    contact confirms the first invoice from the emailed link. Nobody has to sign up first.
 *  - A buyer that exists but is not verified (or was held by screening): an invitation, linked when it is approved.
 */
export async function linkBuyer(
  db: Database,
  p: { sellerId: string; buyerGstin: string; buyerEmail: string; buyerName?: string; creditTermsDays?: number; maxExposure?: bigint },
  gw: Adapters = gateway,
) {
  const gstin = p.buyerGstin.trim().toUpperCase();
  if (!GSTIN.test(gstin)) throw new Error("invalid GSTIN");
  if ((await statusOf(db, p.sellerId)) !== "approved") throw new Error("seller KYB not approved");
  const email = p.buyerEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("enter the buyer's email address");
  await assertContactIsNotSeller(db, p.sellerId, email);

  let [buyer] = await db.select().from(businesses).where(eq(businesses.gstin, gstin));
  if (buyer?.id === p.sellerId) throw new Error("seller and buyer cannot be the same business");
  if (!buyer) {
    const name = p.buyerName?.trim() ?? "";
    if (name.length < 2) throw new Error("enter the buyer's company name");
    const aml = await gw.kyc.screenAml(name); // fail closed: an outage blocks, it does not wave through
    [buyer] = await db.transaction(async (tx) => {
      const [b] = await tx.insert(businesses).values({
        legalName: name, entityType: "unknown", gstin, kind: "buyer", kybLevel: "light",
        kybStatus: aml.hit ? "under_review" : "submitted", kybNote: aml.hit ? "sanctions/PEP screening hit" : null,
      }).returning();
      if (aml.hit) await openCase(tx, { entityType: "business", entityId: b.id, rule: KYB_AML_RULE, subjectBusinessId: b.id, details: { screenedNames: [name], addedBySeller: p.sellerId } });
      await tx.insert(auditLog).values({ action: "buyer.created_by_seller", entity: "business", entityId: b.id, after: { sellerId: p.sellerId, gstin, screened: aml.hit ? "hit" : "clear" } });
      return [b];
    });
  }

  const pending = buyer.kybLevel === "light" && buyer.kybStatus === "submitted"; // named by a supplier, not yet confirmed by its own contact
  if (buyer.kybStatus === "approved" || pending) {
    await db.insert(buyerSellerRelationships).values({
      buyerId: buyer.id, sellerId: p.sellerId, creditTermsDays: p.creditTermsDays ?? 60, maxExposure: p.maxExposure, contactEmail: email,
    }).onConflictDoUpdate({ target: [buyerSellerRelationships.buyerId, buyerSellerRelationships.sellerId], set: { contactEmail: email } });
    await db.insert(auditLog).values({ action: "relationship.link", entity: "business", entityId: p.sellerId, after: { buyerId: buyer.id, pending } });
    return { linked: true as const, buyerId: buyer.id, pending };
  }
  await db.insert(buyerInvites).values({
    sellerId: p.sellerId, buyerGstin: gstin, buyerEmail: email, creditTermsDays: p.creditTermsDays ?? 60,
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
  const [b] = await db.select({ s: businesses.kybStatus, l: businesses.kybLevel }).from(businesses).where(eq(businesses.id, buyerId));
  // Verified, or named by this supplier and awaiting its own contact's first confirmation (light verification happens then).
  if (!(b?.s === "approved" || (b?.s === "submitted" && b.l === "light"))) throw new Error("BUYER_NOT_VERIFIED");
  const [rel] = await db.select().from(buyerSellerRelationships).where(and(
    eq(buyerSellerRelationships.buyerId, buyerId), eq(buyerSellerRelationships.sellerId, sellerId),
  ));
  if (!rel) throw new Error("NO_RELATIONSHIP");
  return rel;
}
