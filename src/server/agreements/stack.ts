// The agreement stack, in one place: every document the platform relies on, who signs it, when, and whether the product produces it.
// "external" means it is signed outside the app (with a bank, or by counsel's own paper) and the platform only records that it exists.
import { COUNTRY_TERMS } from "./country";
import { FINANCIER_TERMS_VERSION, PLATFORM_TERMS_VERSION, PROGRAMME_TERMS_VERSION, TEMPLATE_VERSION } from "./templates";

export type StackItem = { n: number; name: string; signer: string; when: string; how: "in app" | "recorded" | "external"; where: string; version: string };

export const STACK: StackItem[] = [
  { n: 1, name: "Platform terms and privacy notice", signer: "Every user", when: "At signup, or when invited", how: "recorded", where: "Version and time are stored on the user", version: PLATFORM_TERMS_VERSION },
  { n: 2, name: "Seller master receivables agreement", signer: "Seller and financier", when: "Once, at the first accepted offer", how: "in app", where: "Seller > Agreements", version: TEMPLATE_VERSION },
  { n: 3, name: "Invoice schedule", signer: "Seller and financier", when: "Each accepted offer", how: "in app", where: "Seller > Agreements", version: TEMPLATE_VERSION },
  { n: 4, name: "Notice of assignment and acknowledgement", signer: "Sent to the buyer; the buyer acknowledges", when: "Each accepted offer, before payout", how: "in app", where: "Emailed to the buyer; copy under Agreements", version: TEMPLATE_VERSION },
  { n: 5, name: "Buyer acceptance and confirmation record", signer: "Buyer (verified, recorded)", when: "Each invoice", how: "in app", where: "Buyer confirmation page; record on the invoice", version: "wording 2026-10-v1" },
  { n: 6, name: "Supplier finance programme terms", signer: "Buyer when it applies; each supplier when it joins", when: "Once per party", how: "recorded", where: "Buyer > Supplier finance; Seller > Buyers", version: PROGRAMME_TERMS_VERSION },
  { n: 7, name: "Financier participation terms and mandate", signer: "Financier", when: "At application", how: "recorded", where: "Financier > Application, Mandate and limits", version: FINANCIER_TERMS_VERSION },
  { n: 8, name: "Collection account or trust agreement", signer: "Platform, the account bank and where needed the seller", when: "Once per bank relationship", how: "external", where: "With the partner bank; counsel's paper", version: "n/a" },
  { n: 9, name: "Direct-debit or e-mandate consent", signer: "The payer", when: "Per mandate", how: "in app", where: "Buyer > Invoices > Auto-pay", version: "provider flow" },
  { n: 10, name: "Key facts sheet", signer: "Seller acknowledges", when: "Before accepting any offer", how: "in app", where: "Seller > Invoices; copy under Agreements", version: TEMPLATE_VERSION },
];

/** The five clauses that must not be left to a template (see docs/PLATFORM-GUIDE.md section 6). */
export const CRITICAL_CLAUSES = [
  "True sale, recourse and perfection: what is sold, what triggers repurchase, and which notice and registry steps the country needs.",
  "Dispute, dilution and set-off, with the buyer's waiver in a signed writing that says exactly what the buyer undertakes.",
  "Collection account, proceeds and priority: misdirected payments, the trust declaration, the waterfall, funder versus seller.",
  "Pricing consistency: one formula, one day-count basis, one late-charge rule, the same figures in the offer and the key facts sheet.",
  "Electronic execution and evidence: signature level per country, audit trail, timestamps, consent record, governing law and forum.",
];

export const COUNTRIES = Object.values(COUNTRY_TERMS);
