// Tax on the platform's own fees (Module 10 tax computation): GST in India, VAT in Zambia, at the rate in the country pack.
// The processing fee shown to the seller is TAX-INCLUSIVE, so the payout amounts don't change; we split it for the books.
// Interest/discount on financing is not taxed here, so only fees are split. The ledger account is still called gst_payable: it holds
// whichever sales tax the market charges.
// TDS arises when interest is paid out to financiers (Phase 2 payout engine), not in the own-balance-sheet MVP.
import { market } from "../../lib/countries";

export const taxRateBps = () => market().tax.rateBps;

export function splitTax(inclusive: bigint, rateBps = taxRateBps()) {
  const base = (inclusive * 10_000n) / (10_000n + BigInt(rateBps)); // floor; the odd minor unit goes to tax so the parts always sum exactly
  return { base, tax: inclusive - base };
}
