import { market } from "./countries";

/** Parse a major-unit string (rupees, kwacha) ("1234", "1,234.5") to integer paise without floats. Throws on bad input. */
export function rupeesToPaise(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/,/g, "").trim());
  if (!m) throw new Error("invalid amount");
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

/** "USD 12,000.00" from minor units (cents). Display only: money maths stays in bigint. */
export function formatMinor(minor: bigint, currency: string): string {
  const n = Number(minor) / 100;
  return `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Group the whole part the way the home market writes it: Indian (12,34,567) or western (1,234,567). */
const group = (whole: string, g: "indian" | "western") =>
  whole.replace(g === "indian" ? /\B(?=(\d{2})*\d{3}(?!\d))/g : /\B(?=(\d{3})+(?!\d))/g, ",");

/** An amount in the home currency's minor units, written as the market writes it: ₹12,34,567.00 or K1,234,567.00. */
export function formatMoney(minor: bigint): string {
  const { currency: c } = market();
  const neg = minor < 0n;
  const p = neg ? -minor : minor;
  return `${neg ? "-" : ""}${c.symbol}${group((p / 100n).toString(), c.grouping)}.${(p % 100n).toString().padStart(2, "0")}`;
}

/** Exact plain decimal for exports ("1234.50"), no grouping or symbol. */
export function toDecimal(paise: bigint): string {
  const a = paise < 0n ? -paise : paise;
  return `${paise < 0n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Compact amounts for dashboards: ₹950, ₹12.4K, ₹8.9L, ₹1.2Cr, or K12.4k, K1.2m. Display only; never used for arithmetic. */
export function formatCompactMoney(minor: bigint): string {
  const { currency: c } = market();
  const neg = minor < 0n;
  const r = Number(neg ? -minor : minor) / 100;
  const sign = neg ? "-" : "";
  for (const [size, unit] of c.compact) {
    if (r >= size) { const n = r / size; return `${sign}${c.symbol}${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")}${unit}`; }
  }
  return `${sign}${c.symbol}${Math.round(r)}`;
}
