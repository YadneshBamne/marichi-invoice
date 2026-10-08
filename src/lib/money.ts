/** Parse a rupee string ("1234", "1,234.5") to integer paise without floats. Throws on bad input. */
export function rupeesToPaise(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/,/g, "").trim());
  if (!m) throw new Error("invalid amount");
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

export function formatINR(paise: bigint): string {
  const neg = paise < 0n;
  const p = neg ? -paise : paise;
  // Indian grouping: last three digits, then pairs (12,34,567).
  const r = (p / 100n).toString().replace(/\B(?=(\d{2})*\d{3}(?!\d))/g, ",");
  return `${neg ? "-" : ""}₹${r}.${(p % 100n).toString().padStart(2, "0")}`;
}

/** Exact plain decimal for exports ("1234.50"), no grouping or symbol. */
export function toDecimal(paise: bigint): string {
  const a = paise < 0n ? -paise : paise;
  return `${paise < 0n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Compact rupees for dashboards: ₹950, ₹12.4K, ₹8.9L, ₹1.2Cr. Display only; never used for arithmetic. */
export function formatCompactINR(paise: bigint): string {
  const neg = paise < 0n;
  const r = Number(neg ? -paise : paise) / 100;
  const f = (n: number, u: string) => `${neg ? "-" : ""}₹${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")}${u}`;
  if (r >= 1e7) return f(r / 1e7, "Cr");
  if (r >= 1e5) return f(r / 1e5, "L");
  if (r >= 1e3) return f(r / 1e3, "K");
  return `${neg ? "-" : ""}₹${Math.round(r)}`;
}
