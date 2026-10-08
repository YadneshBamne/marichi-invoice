// Pure collections maths (Module 9). Integer paise, UTC calendar dates as YYYY-MM-DD. No DB, no I/O.
export const COLLECTIONS = {
  graceDays: 5, // PRD: 3-7 days after the due date before recourse/default classification
  penalBps: 1200, // illustrative: 12% p.a. on overdue principal, on top of the contractual discount
  writeOffAfterDpd: 90, // NPA threshold
};

export type State = { principal: bigint; discount: bigint; penal: bigint; lastAccrued: string };
export type Rates = { discountBps: number; penalBps: number; dueDate: string };
export type Paid = { principal: bigint; discount: bigint; penal: bigint };

export const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => dayNum(to) - dayNum(from);

/** Accrue discount on outstanding principal from `lastAccrued` to `to`, plus penal on days beyond the due date. Never goes backwards. */
export function accrue(s: State, to: string, r: Rates): State {
  const days = daysBetween(s.lastAccrued, to);
  if (days <= 0 || s.principal === 0n) return { ...s, lastAccrued: days > 0 ? to : s.lastAccrued };
  const overdueDays = Math.max(0, daysBetween(s.lastAccrued > r.dueDate ? s.lastAccrued : r.dueDate, to));
  const year = 10_000n * 365n;
  return {
    ...s,
    discount: s.discount + (s.principal * BigInt(r.discountBps) * BigInt(days)) / year,
    penal: s.penal + (s.principal * BigInt(r.penalBps) * BigInt(overdueDays)) / year,
    lastAccrued: to,
  };
}

/**
 * Apply a payment in the PRD waterfall order: principal -> discount -> fees -> penal.
 * (Fees are all collected upfront in Phase 1, so there is no fee bucket.) Whatever is left is the seller's surplus.
 */
export function applyPayment(s: State, amount: bigint): { state: State; paid: Paid; surplus: bigint } {
  if (amount <= 0n) throw new Error("payment must be positive");
  let left = amount;
  const take = (due: bigint) => { const t = left < due ? left : due; left -= t; return t; };
  const paid = { principal: take(s.principal), discount: 0n, penal: 0n };
  paid.discount = take(s.discount);
  paid.penal = take(s.penal);
  return {
    state: { ...s, principal: s.principal - paid.principal, discount: s.discount - paid.discount, penal: s.penal - paid.penal },
    paid,
    surplus: left,
  };
}

export const totalDue = (s: State) => s.principal + s.discount + s.penal;

export type Bucket = "0" | "1-30" | "31-60" | "61-90" | "90+";
/** Days past due -> delinquency bucket. 90+ is NPA. */
export function bucketOf(dpd: number): Bucket {
  return dpd <= 0 ? "0" : dpd <= 30 ? "1-30" : dpd <= 60 ? "31-60" : dpd <= 90 ? "61-90" : "90+";
}
