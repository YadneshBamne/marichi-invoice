// Offer maths. Integer paise only; every division floors (never rounds in the seller's disfavour silently).
export const OFFER = {
  validityHours: 24, // PRD Module 6: offer expiry window
  processingFeeBps: 50, // 0.5% of invoice value, deducted upfront (PRD Module 8)
  defaultPlatformCapital: 5_00_00_000_00n, // ₹5 Cr balance sheet available for Phase 1 (override: PLATFORM_CAPITAL_PAISE)
  minPartialAdvance: 10_000_00n, // a seller may finance part of an invoice, but not less than ₹10,000
};

export const platformCapital = () =>
  process.env.PLATFORM_CAPITAL_PAISE ? BigInt(process.env.PLATFORM_CAPITAL_PAISE) : OFFER.defaultPlatformCapital;

export type Priced = {
  advanceAmount: bigint; feeAmount: bigint; expectedDiscount: bigint;
  netDisbursal: bigint; // paid to the seller now
  effectiveAprBps: number; // all-in annualised cost: PRD 7.2 rate transparency
};

/**
 * `advanceAmount` lets the seller finance less than the maximum (partial financing). The upfront fee is charged on the
 * part of the invoice actually financed, so it scales with the advance. Omitted = the full advance, as before.
 */
export function priceOffer(p: { amount: bigint; advanceBps: number; discountBps: number; tenorDays: number; feeBps?: number; advanceAmount?: bigint }): Priced {
  if (p.tenorDays < 1 || p.advanceBps <= 0) throw new Error("cannot price offer");
  const maxAdvance = (p.amount * BigInt(p.advanceBps)) / 10_000n;
  const advanceAmount = p.advanceAmount ?? maxAdvance;
  if (advanceAmount <= 0n || advanceAmount > maxAdvance) throw new Error("the advance must be more than zero and no more than the maximum offered");
  if (p.advanceAmount !== undefined && advanceAmount < maxAdvance && advanceAmount < OFFER.minPartialAdvance) throw new Error("the advance is below the minimum that can be financed");
  const fullFee = (p.amount * BigInt(p.feeBps ?? OFFER.processingFeeBps)) / 10_000n;
  const feeAmount = advanceAmount === maxAdvance ? fullFee : (fullFee * advanceAmount) / maxAdvance;
  const expectedDiscount = (advanceAmount * BigInt(p.discountBps) * BigInt(p.tenorDays)) / (10_000n * 365n);
  const netDisbursal = advanceAmount - feeAmount;
  // Cost over what the seller actually receives today (advance less upfront fee), so the fee isn't hidden.
  const effectiveAprBps = Number(((expectedDiscount + feeAmount) * 10_000n * 365n) / (netDisbursal * BigInt(p.tenorDays)));
  return { advanceAmount, feeAmount, expectedDiscount, netDisbursal, effectiveAprBps };
}

/** What the seller nets and what it costs, from the numbers stored on an offer (works for partial advances too). */
export function describeOffer(o: { advanceAmount: bigint; feeAmount: bigint; expectedDiscount: bigint; tenorDays: number }) {
  const netDisbursal = o.advanceAmount - o.feeAmount;
  const effectiveAprBps = Number(((o.expectedDiscount + o.feeAmount) * 10_000n * 365n) / (netDisbursal * BigInt(o.tenorDays)));
  return { netDisbursal, effectiveAprBps };
}
