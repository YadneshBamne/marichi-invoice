// Standing bids. A financier that switches automatic bidding on in its mandate bids on every open deal that fits the mandate, at the
// discount and advance it set. The normal bid path does the checking (licence, mandate, buyer limit, cash), so an automatic bid can
// never do what a manual one could not. Anything it cannot place is skipped quietly; the financier can still bid by hand.
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { financierMandates, financierProfiles } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { dealFlow, placeBid } from "./service";

export async function runAutoBids(db: Database, gw: Adapters = gateway, now = new Date()) {
  const rows = await db.select({ m: financierMandates }).from(financierMandates).innerJoin(financierProfiles, eq(financierProfiles.businessId, financierMandates.businessId))
    .where(and(eq(financierMandates.autoBid, true), eq(financierMandates.status, "active"), eq(financierProfiles.status, "approved")));
  let placed = 0;
  for (const { m } of rows) {
    if (!m.updatedBy || !m.autoDiscountBps) continue; // a standing rule belongs to the person who set it
    for (const d of await dealFlow(db, m.businessId, now)) {
      if (d.myBid) continue; // already bidding on it
      const advanceBps = Math.min(d.maxAdvanceBps, m.autoAdvanceBps ?? d.maxAdvanceBps);
      try {
        await placeBid(db, { id: m.updatedBy, role: "financier", businessId: m.businessId }, { invoiceId: d.invoiceId, advanceBps, discountBps: m.autoDiscountBps }, gw, now);
        placed++;
      } catch { /* outside the mandate, no limit on this buyer, not enough cash: skip */ }
    }
  }
  return placed;
}
