import { describe, expect, it } from "vitest";
import { decide, partyScore, type Inputs, type Party } from "./policy";

const party = (over: Partial<Party> = {}): Party => ({ bureauScore: 780, paidCount: 3, overdueCount: 0, maxDpd: 0, ...over });
const base = (over: Partial<Inputs> = {}): Inputs => ({
  invoiceAmount: 5_00_000_00n, tenorDays: 45, irnStatus: "verified",
  seller: { ...party(), outstanding: 0n, limit: 1_00_00_000_00n },
  buyer: { ...party(), outstandingForSeller: 0n, cap: 50_00_000_00n },
  ...over,
});
const codes = (i: Inputs) => decide(i).reasons.map((r) => r.code);

describe("scoring", () => {
  it("partyScore bands and history", () => {
    expect(partyScore(party({ bureauScore: 780, paidCount: 0 }))).toBe(100);
    expect(partyScore(party({ bureauScore: 660, paidCount: 0 }))).toBe(60);
    expect(partyScore(party({ bureauScore: null, paidCount: 0 }))).toBe(40);
    expect(partyScore(party({ bureauScore: 700, paidCount: 5, overdueCount: 1 }))).toBe(60);
  });
});

describe("decide", () => {
  it("strong parties, verified IRN, small ticket -> auto-approved grade A at full advance", () => {
    expect(decide(base())).toMatchObject({ decision: "approved", grade: "A", advanceRateBps: 9000, discountRateBps: 1200 });
  });

  it("no verified IRN cuts the advance (compensating control)", () => {
    const o = decide(base({ irnStatus: "absent" }));
    expect(o.advanceRateBps).toBe(8500);
    expect(o.reasons.map((r) => r.code)).toContain("NO_IRN_COMPENSATING");
  });

  it("invoice above the grade's auto-approval limit is referred, not declined", () => {
    const o = decide(base({ invoiceAmount: 30_00_000_00n })); // grade A auto limit is ₹25L
    expect(o.decision).toBe("referred");
    expect(o.reasons.map((r) => r.code)).toContain("MANUAL_REVIEW");
  });

  it("an invoice can never grade better than its buyer", () => {
    // seller 100, buyer 40 -> blended 64 (C) but buyer is D
    const o = decide(base({ buyer: { ...party({ bureauScore: null, paidCount: 0 }), outstandingForSeller: 0n, cap: 50_00_000_00n } }));
    expect(o.grade).toBe("D");
    expect(o.decision).toBe("referred"); // grade D is always manual
  });

  it("weak bureau + current overdue -> grade E declined", () => {
    const weak = party({ bureauScore: 620, overdueCount: 1, maxDpd: 5 });
    const o = decide(base({ seller: { ...weak, outstanding: 0n, limit: 1_00_00_000_00n }, buyer: { ...weak, outstandingForSeller: 0n, cap: 50_00_000_00n } }));
    expect(o).toMatchObject({ decision: "declined", grade: "E" });
    expect(o.reasons.at(-1)!.code).toBe("RISK_TOO_HIGH");
  });

  it("hard cut-offs", () => {
    expect(codes(base({ seller: { ...party({ maxDpd: 91 }), outstanding: 0n, limit: 1_00_00_000_00n } }))).toEqual(["ACTIVE_DEFAULT"]);
    expect(codes(base({ buyer: { ...party({ bureauScore: 540 }), outstandingForSeller: 0n, cap: 50_00_000_00n } }))).toEqual(["BUREAU_LOW"]);
    expect(codes(base({ tenorDays: 130 }))).toEqual(["TENOR_OUT_OF_RANGE"]);
    expect(codes(base({ tenorDays: 3 }))).toEqual(["TENOR_OUT_OF_RANGE"]);
    expect(codes(base({ seller: { ...party(), outstanding: 99_00_00_000n, limit: 1_00_00_000_00n } }))).toEqual(["SELLER_LIMIT"]);
    expect(codes(base({ buyer: { ...party(), outstandingForSeller: 48_00_000_00n, cap: 50_00_000_00n }, invoiceAmount: 5_00_000_00n }))).toEqual(["BUYER_CAP"]);
  });

  it("no-hit parties are not auto-rejected; they take the alternative-data path", () => {
    const o = decide(base({ seller: { ...party({ bureauScore: null, paidCount: 0 }), outstanding: 0n, limit: 1_00_00_000_00n } }));
    expect(o.decision).not.toBe("declined");
    expect(o.reasons.map((r) => r.code)).toContain("SELLER_NO_BUREAU");
  });
});
