import type { Pack } from "./types";

export const IN: Pack = {
  code: "IN", name: "India", adjective: "Indian",
  currency: { code: "INR", symbol: "₹", major: "rupee", minor: "paise", grouping: "indian", compact: [[1e7, "Cr"], [1e5, "L"], [1e3, "K"]] },
  ids: {
    kyb: { label: "PAN", pattern: /^[A-Z]{5}\d{4}[A-Z]$/, hint: "Ten characters, for example ABCDE1234F." },
    taxReg: { label: "GSTIN", pattern: /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, hint: "Fifteen characters, for example 27ABCDE1234F1Z5." },
    companyReg: { label: "CIN", pattern: /^[A-Z]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/, hint: "Twenty-one characters. Leave blank for a proprietorship or partnership." },
    msme: { label: "Udyam registration number", pattern: /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, hint: "For example UDYAM-MH-12-0001234. Leave blank if the business is not registered as an MSME." },
    bankCode: { label: "IFSC", pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/, hint: "Eleven characters, for example HDFC0001234." },
    bankAccount: { label: "Account number", pattern: /^\d{9,18}$/, hint: "Nine to eighteen digits." },
    director: "DIN",
  },
  documents: [
    { kind: "tax_registration", label: "GST registration certificate", required: true },
    { kind: "tax_id", label: "PAN card of the business", required: true },
    { kind: "incorporation", label: "Certificate of incorporation (not needed for a proprietorship)", required: false },
    { kind: "udyam", label: "Udyam registration certificate", required: false },
    { kind: "bank_proof", label: "Cancelled cheque or a letter from the bank", required: false },
  ],
  tax: { name: "GST", rateBps: 1800 },
  eInvoice: { short: "IRN", long: "e-invoice reference number", authority: "the Invoice Registration Portal" },
  registry: { text: "the Central Registry of Securitisation Asset Reconstruction and Security Interest of India (CERSAI)", short: "CERSAI", when: "after_assignment", withinDays: 30 },
  rails: { small: ["IMPS", "NEFT"], large: ["RTGS", "NEFT"], largeAbove: 5_00_000_00n },
  mandate: "e-NACH",
  terms: {
    law: "the laws of India", forum: "the courts at [city, to be completed by counsel]",
    esign: "the Information Technology Act, 2000", grievance: "the RBI Integrated Ombudsman Scheme, where it applies",
  },
  privacy: {
    law: "the Digital Personal Data Protection Act, 2023 and its Rules", regulator: "the Data Protection Board of India (and CERT-In for cyber incidents)",
    breachHours: 6, residency: "Payment data is kept in India. Other personal data may be processed abroad except in countries the government restricts.",
  },
  ombudsman: { name: "RBI Integrated Ombudsman Scheme", url: "https://cms.rbi.org.in" },
  regulator: "RBI",
  institutions: { bank: "Bank", nbfc_factor: "NBFC-Factor or factoring company", nbfc: "NBFC or lender", mfi: "Microfinance institution", fund: "Fund", other: "Other licensed institution" },
  phone: "+91", timezone: "Asia/Kolkata",
  platformFunds: true,
  policyScale: [1, 1],
};
