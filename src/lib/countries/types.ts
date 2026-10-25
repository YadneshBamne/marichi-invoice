// A country pack is plain data: everything that changes from one home market to the next. It has no server imports, so pages,
// emails, agreements and the policy registry all read the same facts. Every legal statement in a pack is a DRAFT for local counsel
// (docs/PLATFORM-GUIDE.md section 9); bracketed text is deliberately left for them.

export type Rail = "IMPS" | "NEFT" | "RTGS" | "ZIPSS" | "EFT";

/** One identifier a person types: the label to show, the pattern it must match, and a hint under the field. */
export type IdSpec = { label: string; pattern: RegExp; hint: string };

/** A document a company is asked to upload for verification. `expires` ones carry a validity date we remind about. */
export type DocSpec = { kind: string; label: string; required: boolean; expires?: boolean };

export type Pack = {
  code: string; name: string; adjective: string;
  currency: {
    code: string; symbol: string; major: string; minor: string;
    grouping: "indian" | "western";
    compact: [number, string][]; // largest first: [1e7, "Cr"]
  };
  ids: {
    kyb: IdSpec; // the company's taxpayer identity, checked at verification
    taxReg: IdSpec; // the number on its invoices that names it as a buyer; one company each
    companyReg: IdSpec | null; // the company registry number, if the country has one
    msme: IdSpec | null; // the small-business registration number, where the country has one (India: Udyam)
    bankCode: IdSpec; bankAccount: IdSpec;
    director: string; // what a director or owner is identified by
  };
  documents: DocSpec[];
  tax: { name: string; rateBps: number }; // on the platform's own fees; the financing discount is not taxed
  eInvoice: { short: string; long: string; authority: string };
  registry: { text: string; short: string; when: "before_payout" | "after_assignment"; withinDays: number | null } | null;
  rails: { small: Rail[]; large: Rail[]; largeAbove: bigint };
  mandate: string; // what the recurring-debit scheme is called
  terms: { law: string; forum: string; esign: string; grievance: string };
  privacy: { law: string; regulator: string; breachHours: number; residency: string };
  ombudsman: { name: string; url: string };
  regulator: string; // who licenses lenders, for the financier form
  institutions: Record<string, string>;
  phone: string; timezone: string;
  platformFunds: boolean; // may the platform lend from its own balance sheet here (licence), or only financiers
  policyScale: [number, number]; // INR-sized policy amounts are multiplied by n/d for this currency
};
