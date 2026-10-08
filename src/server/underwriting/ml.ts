// Model-assisted underwriting. A logistic scoring model sits beside the rules engine and answers the same question
// ("how likely is this invoice to go bad?") from the same inputs, with reason codes a credit analyst can read.
//
// HONEST STATUS: the coefficients below are an expert prior, not a trained model. There is no repayment history to train on
// yet. The point of shipping it now is the plumbing: it scores every decision, records the result next to the rules'
// verdict, and the monitor page measures agreement and, as invoices settle, which of the two predicted outcomes better.
// When enough history exists, replace COEF with fitted values (keep the feature list and bump VERSION): nothing else changes.
//
// Modes (Policy > Underwriting, "ml.mode"): 0 off, 1 shadow (default: scores and records, never changes a decision),
// 2 assist (may only TIGHTEN: an approval the model rates two or more grades worse is sent to a person). It never loosens a
// rule, never overturns a decline, and never makes a decision on its own.
import type { Grade, Inputs } from "./policy";

export const ML = { mode: 1 };
export const VERSION = "prior-1";
const ORDER: Grade[] = ["A", "B", "C", "D", "E"];

type Feature = { key: string; label: string; mean: number; sd: number; w: number; high: string; low: string };
// w > 0 pushes the probability of default up. Standardised by (value - mean) / sd.
const COEF: Feature[] = [
  { key: "buyerBureau", label: "Buyer bureau score", mean: 720, sd: 70, w: -0.55, high: "strong buyer credit score", low: "weak buyer credit score" },
  { key: "sellerBureau", label: "Seller bureau score", mean: 700, sd: 70, w: -0.3, high: "strong seller credit score", low: "weak seller credit score" },
  { key: "buyerOverdue", label: "Buyer overdue obligations", mean: 0.1, sd: 0.4, w: 0.7, high: "buyer has overdue obligations", low: "buyer has no overdue obligations" },
  { key: "sellerOverdue", label: "Seller overdue obligations", mean: 0.1, sd: 0.4, w: 0.45, high: "seller has overdue obligations", low: "seller has no overdue obligations" },
  { key: "buyerPaid", label: "Buyer repayment history", mean: 2, sd: 3, w: -0.25, high: "buyer has paid invoices on time before", low: "buyer has little repayment history" },
  { key: "sellerUtilisation", label: "Seller limit used", mean: 0.35, sd: 0.25, w: 0.35, high: "seller is close to its limit", low: "seller has plenty of limit left" },
  { key: "buyerUtilisation", label: "Buyer exposure used", mean: 0.35, sd: 0.25, w: 0.3, high: "exposure on this buyer is high", low: "exposure on this buyer is low" },
  { key: "tenor", label: "Days to due date", mean: 55, sd: 25, w: 0.3, high: "long time to the due date", low: "short time to the due date" },
  { key: "logAmount", label: "Invoice size", mean: 13.2, sd: 1.1, w: 0.2, high: "large invoice", low: "small invoice" },
  { key: "noIrn", label: "No verified e-invoice number", mean: 0.3, sd: 0.45, w: 0.4, high: "no verified e-invoice number", low: "e-invoice number verified" },
  { key: "noBureau", label: "Missing bureau data", mean: 0.2, sd: 0.4, w: 0.25, high: "bureau data missing for a party", low: "bureau data available" },
];
const INTERCEPT = -4.4; // an average invoice scores about a 1.2% probability of default

export type MlReason = { feature: string; text: string; impact: number };
export type MlResult = { version: string; pd: number; grade: Grade; reasons: MlReason[]; features: Record<string, number> };

const ratio = (a: bigint, b: bigint) => (b > 0n ? Math.min(Number((a * 10_000n) / b) / 10_000, 2) : 1);

export function features(i: Inputs): Record<string, number> {
  return {
    buyerBureau: i.buyer.bureauScore ?? 650, sellerBureau: i.seller.bureauScore ?? 650,
    buyerOverdue: i.buyer.overdueCount, sellerOverdue: i.seller.overdueCount, buyerPaid: Math.min(i.buyer.paidCount, 20),
    sellerUtilisation: ratio(i.seller.outstanding + i.invoiceAmount, i.seller.limit),
    buyerUtilisation: ratio(i.buyer.outstandingForSeller + i.invoiceAmount, i.buyer.cap),
    tenor: i.tenorDays, logAmount: Math.log(Math.max(Number(i.invoiceAmount / 100n), 1)),
    noIrn: i.irnStatus === "verified" ? 0 : 1, noBureau: i.seller.bureauScore === null || i.buyer.bureauScore === null ? 1 : 0,
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** Probability of default to a letter grade, with cut-offs between the rules matrix's own PDs (0.5, 1.5, 3.5, 7, 15 per cent). */
export const gradeOfPd = (pd: number): Grade => (pd < 0.01 ? "A" : pd < 0.025 ? "B" : pd < 0.05 ? "C" : pd < 0.1 ? "D" : "E");

export function scoreWithModel(i: Inputs): MlResult {
  const x = features(i);
  const parts = COEF.map((f) => ({ f, impact: (f.w * (x[f.key] - f.mean)) / f.sd }));
  const pd = sigmoid(INTERCEPT + parts.reduce((a, p) => a + p.impact, 0));
  const reasons = parts.filter((p) => Math.abs(p.impact) >= 0.15).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 4)
    .map((p) => ({ feature: p.f.key, impact: Math.round(p.impact * 100) / 100, text: `${p.impact > 0 ? "Raises risk" : "Lowers risk"}: ${p.impact > 0 ? (p.f.w > 0 ? p.f.high : p.f.low) : (p.f.w > 0 ? p.f.low : p.f.high)}` }));
  return { version: VERSION, pd, grade: gradeOfPd(pd), reasons, features: x };
}

/** Grades the model rates worse than the rules (positive = the model is more cautious). */
export const gradeGap = (rules: Grade, ml: Grade) => ORDER.indexOf(ml) - ORDER.indexOf(rules);

/** Assist mode: an approval the model rates two or more grades worse becomes a referral. Nothing else is ever changed. */
export function assist(decision: "approved" | "referred" | "declined", rulesGrade: Grade, ml: MlResult) {
  if (ML.mode !== 2 || decision !== "approved" || gradeGap(rulesGrade, ml.grade) < 2) return null;
  return { code: "ML_REVIEW", text: `Model review: the scoring model rates this grade ${ml.grade} (rules: ${rulesGrade}). ${ml.reasons[0]?.text ?? ""}`.trim() };
}
