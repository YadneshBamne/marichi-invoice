// Who funds an offer, and in what shares. An offer funded by one financier has no share rows: it is 100% that financier. An offer funded
// by several (accepted from a group of bids) has one row each. Everything that moves money for a financed invoice (payout, repayment,
// loss) asks here, so one and many financiers are handled by the same code.
import { and, desc, eq } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { financierProfiles, offerShares } from "../db/schema";

export type Participant = { financierId: string; shareBps: number; advanceAmount: bigint; tdsBps: number };

/** Split a total by shares in whole minor units: each part rounds down and the first (the lead) takes what is left, so the parts always add up. */
export function splitAmount(total: bigint, shareBps: number[]): bigint[] {
  const parts = shareBps.map((s) => (total * BigInt(s)) / 10_000n);
  parts[0] += total - parts.reduce((a, b) => a + b, 0n);
  return parts;
}

/** The financiers behind an offer, the lead first. Empty for an offer funded by the platform's own balance sheet. */
export async function participantsOf(db: Database | Tx, offer: { id: string; financierId: string | null; advanceAmount: bigint }): Promise<Participant[]> {
  if (!offer.financierId) return [];
  const rows = await db.select({ f: offerShares.financierId, s: offerShares.shareBps, a: offerShares.advanceAmount, tds: financierProfiles.tdsBps })
    .from(offerShares).leftJoin(financierProfiles, eq(financierProfiles.businessId, offerShares.financierId))
    .where(eq(offerShares.offerId, offer.id)).orderBy(desc(offerShares.shareBps), offerShares.createdAt);
  if (rows.length) {
    // The lead is the largest share; put it first so it takes the rounding remainder.
    return rows.map((r) => ({ financierId: r.f, shareBps: r.s, advanceAmount: r.a, tdsBps: r.tds ?? 0 }));
  }
  const [prof] = await db.select({ tds: financierProfiles.tdsBps }).from(financierProfiles).where(and(eq(financierProfiles.businessId, offer.financierId)));
  return [{ financierId: offer.financierId, shareBps: 10_000, advanceAmount: offer.advanceAmount, tdsBps: prof?.tds ?? 0 }];
}
