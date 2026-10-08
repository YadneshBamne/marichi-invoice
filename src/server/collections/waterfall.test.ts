import { describe, expect, it } from "vitest";
import { accrue, applyPayment, bucketOf, daysBetween, totalDue, type State } from "./waterfall";

const rates = { discountBps: 1200, penalBps: 1200, dueDate: "2026-11-20" };
const fresh = (principal = 9_00_000_00n, lastAccrued = "2026-10-06"): State => ({ principal, discount: 0n, penal: 0n, lastAccrued });

describe("accrue", () => {
  it("discount accrues daily on principal; no penal before the due date", () => {
    const s = accrue(fresh(), "2026-11-20", rates); // 45 days
    expect(s.discount).toBe(13_315_06n); // matches the offer's expected discount (₹9L * 12% * 45/365)
    expect(s.penal).toBe(0n);
    expect(s.lastAccrued).toBe("2026-11-20");
  });
  it("penal accrues only for days beyond the due date", () => {
    const s = accrue(accrue(fresh(), "2026-11-20", rates), "2026-12-05", rates); // 15 days late
    expect(s.penal).toBe((9_00_000_00n * 1200n * 15n) / (10_000n * 365n));
    expect(s.discount).toBeGreaterThan(13_315_06n);
  });
  it("one jump across the due date gives the same penal days as stepping", () => {
    const jump = accrue(fresh(), "2026-12-05", rates);
    expect(jump.penal).toBe((9_00_000_00n * 1200n * 15n) / (10_000n * 365n));
  });
  it("never accrues backwards or twice for the same day", () => {
    const s = accrue(fresh(), "2026-10-20", rates);
    expect(accrue(s, "2026-10-20", rates)).toEqual(s);
    expect(accrue(s, "2026-10-01", rates)).toEqual(s);
  });
  it("nothing accrues once principal is cleared", () => {
    expect(accrue({ ...fresh(0n), discount: 5n }, "2026-12-01", rates).discount).toBe(5n);
  });
});

describe("applyPayment waterfall", () => {
  const s: State = { principal: 1000n, discount: 100n, penal: 50n, lastAccrued: "2026-11-20" };
  it("principal -> discount -> penal, remainder is surplus", () => {
    expect(applyPayment(s, 1500n)).toMatchObject({ paid: { principal: 1000n, discount: 100n, penal: 50n }, surplus: 350n });
  });
  it("partial payments fill buckets in order", () => {
    expect(applyPayment(s, 600n).paid).toEqual({ principal: 600n, discount: 0n, penal: 0n });
    const r = applyPayment(s, 1120n);
    expect(r.paid).toEqual({ principal: 1000n, discount: 100n, penal: 20n });
    expect(totalDue(r.state)).toBe(30n);
    expect(r.surplus).toBe(0n);
  });
  it("conserves money: paid + surplus = payment", () => {
    for (const amt of [1n, 999n, 1000n, 1100n, 1150n, 5000n]) {
      const r = applyPayment(s, amt);
      expect(r.paid.principal + r.paid.discount + r.paid.penal + r.surplus).toBe(amt);
    }
  });
  it("rejects non-positive", () => { expect(() => applyPayment(s, 0n)).toThrow(); });
});

describe("helpers", () => {
  it("bucketOf", () => {
    expect([0, -3, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual(["0", "0", "1-30", "1-30", "31-60", "31-60", "61-90", "61-90", "90+"]);
  });
  it("daysBetween", () => { expect(daysBetween("2026-10-06", "2026-11-20")).toBe(45); });
});
