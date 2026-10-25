// What changes in an agreement from one country to the next: the governing law, the forum, the registry where an assignment is
// filed, and the law behind electronic signature. The facts live in the country packs (src/lib/countries); each is a DRAFT for local
// counsel to confirm before launch in that country (docs/PLATFORM-GUIDE.md section 9). Bracketed text is deliberately left for
// counsel and is shown to nobody as settled law.
import { PACKS, packOf } from "../../lib/countries";

export type CountryTerms = {
  code: string; name: string; law: string; forum: string;
  registry: string | null; // where an assignment of receivables is filed, when the law has such a place
  esign: string; // the law that makes an electronic signature valid
  grievance: string; // where an unresolved complaint can be taken
};

export const COUNTRY_TERMS: Record<string, CountryTerms> = Object.fromEntries(
  Object.values(PACKS).map((p) => [p.code, { code: p.code, name: p.name, ...p.terms, registry: p.registry?.text ?? null }]),
);

const GENERIC: CountryTerms = {
  code: "XX", name: "the country concerned", law: "[the governing law, to be completed by counsel]", forum: "[the forum, to be completed by counsel]",
  registry: null, esign: "the electronic transactions law of the country concerned", grievance: "the relevant regulator",
};

/** A company with no country recorded belongs to the deployment's home market. A country with no pack gets a generic, counsel-bracketed text. */
export const termsFor = (country: string | null | undefined): CountryTerms =>
  country && !PACKS[country.toUpperCase()] ? GENERIC : COUNTRY_TERMS[packOf(country).code];
