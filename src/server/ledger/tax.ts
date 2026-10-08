// GST on the platform's own fees (Module 10 tax computation).
// The processing fee shown to the seller is GST-INCLUSIVE, so the payout amounts don't change; we split it for the books.
// Interest/discount on financing is not GST-taxable, so only fees are split.
// TDS arises when interest is paid out to financiers (Phase 2 payout engine), not in the own-balance-sheet MVP.
export const GST_BPS = 1800; // 18%

export function splitGst(inclusive: bigint, rateBps = GST_BPS) {
  const base = (inclusive * 10_000n) / (10_000n + BigInt(rateBps)); // floor; the odd paisa goes to GST so the parts always sum exactly
  return { base, gst: inclusive - base };
}
