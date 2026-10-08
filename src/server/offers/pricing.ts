// Offer maths. Integer paise only; every division floors (never rounds in the seller's disfavour silently).
export const OFFER = {
  validityHours: 24, // PRD Module 6: offer expiry window
  processingFeeBps: 50, // 0.5% of invoice value, deducted upfront (PRD Module 8)
  defaultPlatformCapital: 5_00_00_000_00n, // ₹5 Cr balance sheet available for Phase 1 (override: PLATFORM_CAPITAL_PAISE)
};

export const platformCapital = () =>
  process.env.PLATFORM_CAPITAL_PAISE ? BigInt(process.env.PLATFORM_CAPITAL_PAISE) : OFFER.defaultPlatformCapital;

export type Priced = {
  advanceAmount: bigint; feeAmount: bigint; expectedDiscount: bigint;
  netDisbursal: bigint; // paid to the seller now
  effectiveAprBps: number; // all-in annualised cost: PRD 7.2 rate transparency
};

export function priceOffer(p: { amount: bigint; advanceBps: number; discountBps: number; tenorDays: number; feeBps?: number }): Priced {
  if (p.tenorDays < 1 || p.advanceBps <= 0) throw new Error("cannot price offer");
  const advanceAmount = (p.amount * BigInt(p.advanceBps)) / 10_000n;
  const feeAmount = (p.amount * BigInt(p.feeBps ?? OFFER.processingFeeBps)) / 10_000n;
  const expectedDiscount = (advanceAmount * BigInt(p.discountBps) * BigInt(p.tenorDays)) / (10_000n * 365n);
  const netDisbursal = advanceAmount - feeAmount;
  // Cost over what the seller actually receives today (advance less upfront fee), so the fee isn't hidden.
  const effectiveAprBps = Number(((expectedDiscount + feeAmount) * 10_000n * 365n) / (netDisbursal * BigInt(p.tenorDays)));
  return { advanceAmount, feeAmount, expectedDiscount, netDisbursal, effectiveAprBps };
}
