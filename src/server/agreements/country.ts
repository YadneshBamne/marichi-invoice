// What changes in an agreement from one country to the next: the governing law, the forum, the registry where an assignment is
// filed, and the law behind electronic signature. Each entry is a DRAFT for local counsel to confirm before launch in that country
// (see docs/PLATFORM-GUIDE.md section 9). Bracketed text is deliberately left for counsel and is shown to nobody as settled law.

export type CountryTerms = {
  code: string; name: string; law: string; forum: string;
  registry: string | null; // where an assignment of receivables is filed, when the law has such a place
  esign: string; // the law that makes an electronic signature valid
  grievance: string; // where an unresolved complaint can be taken
};

export const COUNTRY_TERMS: Record<string, CountryTerms> = {
  IN: {
    code: "IN", name: "India", law: "the laws of India", forum: "the courts at [city, to be completed by counsel]",
    registry: "the Central Registry of Securitisation Asset Reconstruction and Security Interest of India (CERSAI)",
    esign: "the Information Technology Act, 2000", grievance: "the RBI Integrated Ombudsman Scheme, where it applies",
  },
  ZM: {
    code: "ZM", name: "Zambia", law: "the laws of the Republic of Zambia", forum: "[the courts or arbitration seat, to be completed by counsel]",
    registry: "the Collateral Registry maintained by PACRA under the Movable Property (Security Interest) Act, 2016",
    esign: "the Electronic Communications and Transactions Act, 2021", grievance: "the Bank of Zambia, where it applies",
  },
};

const GENERIC: CountryTerms = {
  code: "XX", name: "the country concerned", law: "[the governing law, to be completed by counsel]", forum: "[the forum, to be completed by counsel]",
  registry: null, esign: "the electronic transactions law of the country concerned", grievance: "the relevant regulator",
};

/** A seller with no country recorded is an Indian company: that is how the platform began. */
export const termsFor = (country: string | null | undefined): CountryTerms => COUNTRY_TERMS[country ?? "IN"] ?? GENERIC;
