export type Flow = { date: string; amount: number }; // YYYY-MM-DD; negative = cash out, positive = cash in

const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;

/** Annualised internal rate of return for irregular dated cash flows (Excel's XIRR). null if undefined (no sign change / no root). */
export function xirr(flows: Flow[]): number | null {
  if (!flows.some((f) => f.amount < 0) || !flows.some((f) => f.amount > 0)) return null;
  const t0 = Math.min(...flows.map((f) => day(f.date)));
  const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (day(f.date) - t0) / 365), 0);
  let lo = -0.9999, hi = 1000; // bisection: slower than Newton but cannot diverge
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}
