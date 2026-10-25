import { IN } from "./in";
import { ZM } from "./zm";
import type { Pack } from "./types";
import type { IdSpec } from "./types";
export type { IdSpec, Pack, Rail } from "./types";

export const PACKS: Record<string, Pack> = { IN, ZM };

// One deployment serves one home market (its law, licence, bank, currency and data region). NEXT_PUBLIC_MARKET picks the pack and is
// read by the server and the browser alike. Unset means India, which is how the platform began.
const pick = (code: string | undefined): Pack => {
  const p = PACKS[(code ?? "IN").toUpperCase()];
  if (!p) throw new Error(`NEXT_PUBLIC_MARKET=${code} has no country pack. Available: ${Object.keys(PACKS).join(", ")}`);
  return p;
};
let current = pick(process.env.NEXT_PUBLIC_MARKET);

/** The country pack this deployment runs. */
export const market = (): Pack => current;
/** The pack for a country code, with the home market as the fallback (a company with no country recorded is a home company). */
export const packOf = (country: string | null | undefined): Pack => (country ? PACKS[country.toUpperCase()] : undefined) ?? current;
/** Tests only: pretend this deployment serves another market. Pair with applyMarketPolicy() on the server. */
export const setMarketForTests = (code: string) => { current = pick(code); };

/** Tidy what a person typed (spaces, case) so it can be compared with a pattern and stored the same way every time. */
export const cleanId = (v: string) => v.replace(/\s+/g, "").toUpperCase();

/** The identifier in its tidy form, or an error that names the field the way this country does. Blank is allowed only when `optional`. */
export function checkId(spec: IdSpec, value: string | null | undefined, optional = false): string | undefined {
  const v = cleanId(value ?? "");
  if (!v) { if (optional) return undefined; throw new Error(`${spec.label} is required`); }
  if (!spec.pattern.test(v)) throw new Error(`invalid ${spec.label}. ${spec.hint}`);
  return v;
}
