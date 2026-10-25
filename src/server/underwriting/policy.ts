import { market } from "../../lib/countries";
// Rules-based underwriting policy (Module 5, Phase 1). Pure: no DB, no I/O, so every rule is testable.
// All numbers are illustrative defaults; they move to admin-console config (Module 15) later.
export type Grade = "A" | "B" | "C" | "D" | "E";
const ORDER: Grade[] = ["A", "B", "C", "D", "E"];

export const POLICY = {
  minBureauScore: 550,
  maxDpdAllowed: 90,
  minTenorDays: 7,
  maxTenorDays: 120,
  defaultSellerLimit: 1_00_00_000_00n, // ₹1 Cr total outstanding per seller
  defaultBuyerCap: 50_00_000_00n, // ₹50 L outstanding per seller-buyer pair
  noIrnAdvanceCutBps: 500, // compensating control when no e-invoice IRN (PRD 12.4)
  // grade -> pricing. discount is annualised. autoMax = largest invoice auto-approved at that grade.
  matrix: {
    A: { advanceBps: 9000, discountBps: 1200, pd: "0.0050", autoMax: 25_00_000_00n },
    B: { advanceBps: 8500, discountBps: 1500, pd: "0.0150", autoMax: 15_00_000_00n },
    C: { advanceBps: 8000, discountBps: 1800, pd: "0.0350", autoMax: 10_00_000_00n },
    D: { advanceBps: 7000, discountBps: 2200, pd: "0.0700", autoMax: 0n }, // always manual
    E: { advanceBps: 0, discountBps: 0, pd: "0.1500", autoMax: 0n },
  } as Record<Grade, { advanceBps: number; discountBps: number; pd: string; autoMax: bigint }>,
};

export type Party = {
  bureauScore: number | null; // null = no-hit / no consent -> alternative-data path
  paidCount: number;
  overdueCount: number;
  maxDpd: number; // worst current days-past-due (999 if anything written off)
};
export type Inputs = {
  invoiceAmount: bigint;
  tenorDays: number; // today -> due date
  irnStatus: string;
  seller: Party & { outstanding: bigint; limit: bigint };
  buyer: Party & { outstandingForSeller: bigint; cap: bigint };
};
export type Reason = { code: string; text: string };
export type Outcome = {
  decision: "approved" | "referred" | "declined";
  grade: Grade; pd: string; advanceRateBps: number; discountRateBps: number; reasons: Reason[];
};

const worse = (a: Grade, b: Grade) => ORDER[Math.max(ORDER.indexOf(a), ORDER.indexOf(b))];
const gradeFrom = (s: number): Grade => (s >= 80 ? "A" : s >= 65 ? "B" : s >= 50 ? "C" : s >= 35 ? "D" : "E");
const bureauPts = (s: number | null) => (s === null ? 40 : s >= 750 ? 100 : s >= 700 ? 80 : s >= 650 ? 60 : s >= 600 ? 40 : 20);

/** 0-100 for one party: bureau band + on-platform repayment behaviour. */
export function partyScore(p: Party) {
  let s = bureauPts(p.bureauScore);
  if (p.overdueCount > 0) s -= 20;
  else if (p.paidCount >= 3) s += 10;
  else if (p.paidCount >= 1) s += 5;
  return Math.max(0, Math.min(100, s));
}

export function decide(i: Inputs): Outcome {
  const reasons: Reason[] = [];
  const decline = (code: string, text: string) => {
    reasons.push({ code, text });
    return { decision: "declined", grade: "E", pd: POLICY.matrix.E.pd, advanceRateBps: 0, discountRateBps: 0, reasons } as Outcome;
  };

  // 1. Hard cut-offs: any one declines.
  if (Math.max(i.seller.maxDpd, i.buyer.maxDpd) > POLICY.maxDpdAllowed) return decline("ACTIVE_DEFAULT", "Seller or buyer has an obligation more than 90 days past due");
  for (const [who, b] of [["Seller", i.seller], ["Buyer", i.buyer]] as const) {
    if (b.bureauScore !== null && b.bureauScore < POLICY.minBureauScore) return decline("BUREAU_LOW", `${who} credit bureau score is below ${POLICY.minBureauScore}`);
  }
  if (i.tenorDays < POLICY.minTenorDays || i.tenorDays > POLICY.maxTenorDays) return decline("TENOR_OUT_OF_RANGE", `Time to due date must be ${POLICY.minTenorDays}-${POLICY.maxTenorDays} days`);
  if (i.seller.outstanding + i.invoiceAmount > i.seller.limit) return decline("SELLER_LIMIT", "Seller credit limit would be exceeded");
  if (i.buyer.outstandingForSeller + i.invoiceAmount > i.buyer.cap) return decline("BUYER_CAP", "Exposure cap on this buyer would be exceeded");

  // 2. Score. Buyer is the primary driver (it pays); the invoice can never grade better than the buyer.
  const sellerScore = partyScore(i.seller);
  const buyerScore = partyScore(i.buyer);
  const buyerGrade = gradeFrom(buyerScore);
  const grade = worse(gradeFrom(Math.round(0.6 * buyerScore + 0.4 * sellerScore)), buyerGrade);
  reasons.push({ code: "GRADE", text: `Seller score ${sellerScore}, buyer score ${buyerScore} (buyer grade ${buyerGrade}) -> grade ${grade}` });
  if (i.seller.bureauScore === null) reasons.push({ code: "SELLER_NO_BUREAU", text: "No seller bureau data: alternative-data path used" });
  if (i.buyer.bureauScore === null) reasons.push({ code: "BUYER_NO_BUREAU", text: "No buyer bureau data" });
  if (grade === "E") return decline("RISK_TOO_HIGH", "Combined risk grade E");

  // 3. Price it.
  const m = POLICY.matrix[grade];
  let advanceRateBps = m.advanceBps;
  if (i.irnStatus !== "verified") {
    advanceRateBps -= POLICY.noIrnAdvanceCutBps;
    reasons.push({ code: "NO_IRN_COMPENSATING", text: `No verified e-invoice (${market().eInvoice.short}): advance reduced by ${POLICY.noIrnAdvanceCutBps / 100} points` });
  }

  // 4. Auto-approve only inside the grade's ticket threshold; the rest goes to a credit analyst.
  const auto = i.invoiceAmount <= m.autoMax;
  if (!auto) reasons.push({ code: "MANUAL_REVIEW", text: grade === "D" ? "Grade D always needs analyst review" : "Invoice above auto-approval limit for this grade" });
  return { decision: auto ? "approved" : "referred", grade, pd: m.pd, advanceRateBps, discountRateBps: m.discountBps, reasons };
}
