// Pure dynamic-discounting maths. No database imports, so the browser can use it for a live preview.
export const DD = {
  minBps: 600, // lowest yearly discount a buyer can propose
  maxBps: 3600, // highest
  proposalHours: 72, // the seller's time to answer
  payWithinDays: 3, // the buyer's time to pay once accepted
  minDaysEarly: 5, // not worth the handling if the invoice is nearly due
  feeBps: 25, // platform fee on the invoice amount, deducted from the seller's payout (GST-inclusive)
};

/** Pure maths. Every division floors, so the buyer never gets a discount larger than the rate earns. */
export function quoteEarly(amount: bigint, daysEarly: number, discountBps: number, feeBps = DD.feeBps) {
  const discount = (amount * BigInt(discountBps) * BigInt(daysEarly)) / (10_000n * 365n);
  const net = amount - discount;
  const fee = (amount * BigInt(feeBps)) / 10_000n;
  const sellerGets = net - fee;
  // What the seller gives up, annualised, over what it actually receives now.
  const sellerCostBps = sellerGets > 0n ? Number(((discount + fee) * 10_000n * 365n) / (sellerGets * BigInt(daysEarly))) : 0;
  return { discount, net, fee, sellerGets, sellerCostBps };
}

