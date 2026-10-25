// Shared pieces for the accounting connectors (Zoho Books, QuickBooks Online). No database, no UI: only HTTP in, plain rows out.

/** One customer invoice pulled from an accounting system, ready for the invoice import. */
export type ErpInvoiceRow = {
  externalId: string;            // the accounting system's own id for the invoice (for re-sync and de-duplication)
  invoiceNumber: string;
  buyerName: string;
  buyerTaxId: string | null;     // GSTIN (upper case) when the system has one; null when it is missing (the importer decides)
  invoiceDate: string;           // YYYY-MM-DD
  dueDate: string | null;        // YYYY-MM-DD; null when the system has no due date
  amountMinor: bigint;           // total in the currency's minor units (see toMinor in this folder)
  currency: string;              // ISO code, upper case
  poReference: string | null;
};

export type OAuthTokens = { accessToken: string; refreshToken: string; expiresIn: number /* seconds */ };

/** Anything that goes wrong talking to an accounting system, in words a seller can act on. */
export class ConnectorError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

// Minor-unit exponents that are not 2. ISO 4217: everything not listed has 2 decimals.
const ZERO = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "XPF", "PYG", "RWF", "DJF", "GNF", "KMF", "VUV"]);
const THREE = new Set(["BHD", "KWD", "OMR", "JOD", "TND", "IQD", "LYD"]);
export const exponentOf = (currency: string) => (ZERO.has(currency.toUpperCase()) ? 0 : THREE.has(currency.toUpperCase()) ? 3 : 2);

/** A plain decimal ("1234.5", "10000") to minor units without floats. Throws on negatives, exponents or lost precision. */
export function toMinor(text: string | number, currency: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) throw new ConnectorError(`"${text}" is not a plain positive amount`);
  const exp = exponentOf(currency), frac = m[2] ?? "";
  if (/[1-9]/.test(frac.slice(exp))) throw new ConnectorError(`amount ${text} has more decimals than ${currency.toUpperCase()} allows`);
  return BigInt(m[1] + frac.slice(0, exp).padEnd(exp, "0"));
}

/**
 * JSON.parse turns 118000.10 into a float. Money keys are quoted first so the digits reach toMinor untouched.
 * Only the exact keys given are touched (no nested money lives under them in these APIs).
 */
export const quoteMoney = (text: string, keys: string[]) =>
  text.replace(new RegExp(String.raw`("(?:${keys.join("|")})"\s*:\s*)(-?\d+(?:\.\d+)?)(?![\d.eE])`, "g"), '$1"$2"');

/** One HTTP call that returns parsed JSON or throws a ConnectorError with a plain message. errorOf pulls the provider's own message out of a body. */
export async function requestJson(
  f: typeof fetch, who: string, url: string, init: RequestInit, moneyKeys: string[], errorOf: (body: Record<string, unknown>) => string | undefined,
): Promise<Record<string, unknown>> {
  let res: Response;
  try { res = await f(url, init); } catch { throw new ConnectorError(`could not reach ${who}; try again shortly`); }
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try { const j = JSON.parse(quoteMoney(text, moneyKeys)); if (j && typeof j === "object" && !Array.isArray(j)) body = j; } catch { /* handled below */ }
  const why = body ? errorOf(body) : undefined;
  if (!res.ok || why) {
    const hint = res.status === 401 ? " (the connection has expired: reconnect or refresh the token)" : res.status === 429 ? " (too many requests: wait a minute and retry)" : "";
    throw new ConnectorError(`${who} rejected the request: ${why ?? `HTTP ${res.status}`}${hint}`, res.status);
  }
  if (!body) throw new ConnectorError(`${who} sent a reply that could not be read`, res.status);
  return body;
}

export const isoDay = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null);
export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
