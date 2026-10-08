import { describe, expect, it } from "vitest";
import { assertBalanced } from "./post";

describe("assertBalanced", () => {
  it("accepts a balanced disbursement", () => {
    expect(() =>
      assertBalanced([
        { account: "seller:1", direction: "debit", amount: 8000n },
        { account: "escrow", direction: "credit", amount: 8000n },
      ]),
    ).not.toThrow();
  });
  it("rejects unbalanced, zero and single-line entries", () => {
    const d = (amount: bigint) => ({ account: "a", direction: "debit" as const, amount });
    const c = (amount: bigint) => ({ account: "b", direction: "credit" as const, amount });
    expect(() => assertBalanced([d(100n), c(99n)])).toThrow(/unbalanced/);
    expect(() => assertBalanced([d(0n), c(0n)])).toThrow(/> 0/);
    expect(() => assertBalanced([d(100n)])).toThrow(/2 lines/);
  });
});
