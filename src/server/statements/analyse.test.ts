import { describe, expect, it } from "vitest";
import { analyse, counterparty, statementSignals, summaryFromJson, summaryToJson } from "./analyse";
import type { StatementLine } from "./parse";

const rs = (n: number) => BigInt(n) * 100n;
const L = (on: string, narration: string, debit: number, credit: number, balance: number | null): StatementLine =>
  ({ on, narration, debit: rs(debit), credit: rs(credit), balance: balance === null ? null : rs(balance) });

// Opening balance 1,00,000. Every balance below was added up by hand.
const LINES: StatementLine[] = [
  L("2026-01-05", "UPI/CR/1/ACME TRADERS/HDFC", 0, 50_000, 150_000),
  L("2026-01-06", "UPI/DR/2/ACME TRADERS/HDFC", 50_000, 0, 100_000),
  L("2026-01-20", "BY CASH DEPOSIT CDM", 0, 20_000, 120_000),
  L("2026-02-03", "NEFT-HDFCN1234-BETA STEEL LTD-INV", 0, 80_000, 200_000),
  L("2026-02-10", "NEFT-ICICN9-GAMMA FREIGHT-X", 30_000, 0, 170_000),
  L("2026-02-12", "I/W CHQ RET INSUFFICIENT FUNDS 000123", 5_000, 0, 165_000),
  L("2026-02-15", "CHQ DEP RET 000777", 15_000, 0, 150_000),
  L("2026-03-01", "NEFT-HDFCN55-BETA STEEL LTD-INV2", 0, 100_000, 250_000),
  L("2026-03-02", "SALARY/CASH WITHDRAWAL", 260_000, 0, -10_000),
  L("2026-03-04", "NEFT-HDFCN77-BETA STEEL LTD-INV3", 0, 15_000, 5_000),
];
const codes = (s: { flags: { code: string }[] }) => s.flags.map((f) => f.code).sort();

describe("statement figures", () => {
  const s = analyse(LINES);

  it("turnover, months and balances", () => {
    expect(s).toMatchObject({ rows: 10, periodFrom: "2026-01-05", periodTo: "2026-03-04", months: 3, totalCredits: rs(265_000), totalDebits: rs(360_000) });
    expect(s.avgMonthlyTurnover).toBe(8_833_333n); // 26,500,000 paise / 3
    expect(s.minBalance).toBe(rs(-10_000));
    // 59 days; the days' closing balances add up to 7,800,000 rupees
    expect(s.daysCovered).toBe(59);
    expect(s.avgBalance).toBe(13_220_338n);
    expect(s.byMonth).toEqual([
      { month: "2026-01", credits: rs(70_000), debits: rs(50_000), avgBalance: 11_074_074n, minBalance: rs(100_000) }, // 2,990,000 / 27 days
      { month: "2026-02", credits: rs(80_000), debits: rs(50_000), avgBalance: 16_339_285n, minBalance: rs(150_000) }, // 4,575,000 / 28 days
      { month: "2026-03", credits: rs(115_000), debits: rs(260_000), avgBalance: 5_875_000n, minBalance: rs(-10_000) }, // 235,000 / 4 days
    ]);
  });

  it("days below zero and below 10,000", () => {
    expect(s.daysNegative).toBe(2); // 2 and 3 March
    expect(s.daysLow).toBe(3); // plus 4 March at 5,000
  });

  it("bounces, cash share, round trips", () => {
    expect(s.inwardReturns).toEqual({ count: 1, amount: rs(5_000) });
    expect(s.outwardReturns).toEqual({ count: 1, amount: rs(15_000) });
    expect(s.cashDeposits).toBe(rs(20_000));
    expect(s.cashShareBps).toBe(754); // 20,000 of 2,65,000
    expect(s.roundTrips).toEqual({ count: 1, amount: rs(50_000), shareBps: 1886 }); // 50,000 in on 5 Jan, out on 6 Jan
  });

  it("top payers and payees, and how concentrated the credits are", () => {
    expect(s.topPayers).toEqual([{ name: "BETA STEEL LTD", total: rs(195_000), count: 3 }, { name: "ACME TRADERS", total: rs(50_000), count: 1 }]);
    expect(s.topPayees).toEqual([{ name: "ACME TRADERS", total: rs(50_000), count: 1 }, { name: "GAMMA FREIGHT", total: rs(30_000), count: 1 }]);
    expect(s.topPayerShareBps).toBe(7358);
  });

  it("a clean running balance has no integrity problems", () => {
    expect(s.integrity).toEqual({ balanceRows: 9, balanceBreaks: 0, outOfOrder: 0, duplicates: 0 });
    expect(codes(s)).toEqual(["concentrated_credits", "inward_returns", "negative_balance", "outward_returns", "round_trips", "short_history"]);
    expect(s.flags.find((f) => f.code === "short_history")?.severity).toBe("low");
    expect(statementSignals(s).map((f) => f.code).sort()).toEqual(["concentrated_credits", "inward_returns", "negative_balance", "outward_returns", "round_trips"]);
  });

  it("figures survive being stored as JSON", () => {
    expect(summaryFromJson(summaryToJson(s))).toEqual(s);
  });
});

describe("a tampered statement", () => {
  it("an edited amount breaks the running balance once, and it is the first thing flagged", () => {
    const edited = LINES.map((l, i) => (i === 4 ? { ...l, debit: rs(3_000) } : l)); // 30,000 changed to 3,000; the balance was left alone
    const s = analyse(edited);
    expect(s.integrity).toMatchObject({ balanceRows: 9, balanceBreaks: 1 });
    expect(s.flags[0]).toMatchObject({ code: "balance_break", severity: "high" });
    expect(statementSignals(s)[0].code).toBe("balance_break");
  });
  it("a deleted row breaks it too", () => {
    expect(analyse(LINES.filter((_, i) => i !== 3)).integrity.balanceBreaks).toBe(1); // 80,000 credit removed
  });
  it("a pasted copy of a row and shuffled dates are named", () => {
    const dup = analyse([...LINES.slice(0, 3), LINES[2], ...LINES.slice(3)]);
    expect(dup.integrity.duplicates).toBe(1);
    expect(codes(dup)).toContain("duplicate_rows");
    const swapped = analyse([...LINES.slice(0, 3), LINES[4], LINES[3], ...LINES.slice(5)]);
    expect(swapped.integrity.outOfOrder).toBe(1);
    expect(codes(swapped)).toContain("dates_out_of_order");
  });
});

describe("other flags", () => {
  it("no balance column: balances are skipped and said so", () => {
    const s = analyse(LINES.map((l) => ({ ...l, balance: null })));
    expect(s).toMatchObject({ minBalance: null, avgBalance: null, daysCovered: 0, integrity: { balanceRows: 0, balanceBreaks: 0 } });
    expect(codes(s)).toContain("no_balance");
  });
  it("one dominant payer, and mostly cash", () => {
    const s = analyse([
      L("2026-01-02", "CASH DEP BRANCH", 0, 60_000, 60_000), L("2026-01-09", "NEFT-HDFCN1-OMEGA CO-X", 0, 40_000, 100_000),
      L("2026-02-02", "BY CASH 22", 0, 10_000, 110_000), L("2026-03-02", "UPI/CR/3/OMEGA CO/HDFC", 0, 90_000, 200_000),
      L("2026-04-02", "NEFT-HDFCN2-OMEGA CO-Y", 0, 300_000, 500_000), L("2026-05-02", "NEFT-HDFCN3-OMEGA CO-Z", 0, 200_000, 700_000),
      L("2026-06-02", "NEFT-HDFCN4-OMEGA CO-W", 0, 100_000, 800_000),
    ]);
    expect(s.months).toBe(6);
    expect(codes(s)).not.toContain("short_history");
    expect(s.cashShareBps).toBe(875); // 70,000 of 8,00,000
    expect(s.topPayerShareBps).toBe(9125); // 7,30,000 of 8,00,000
    expect(s.flags.find((f) => f.code === "concentrated_credits")?.severity).toBe("high");
    const cash = analyse([L("2026-01-02", "CASH DEPOSIT", 0, 60_000, 60_000), L("2026-01-09", "CHQ DEP 55", 0, 40_000, 100_000), L("2026-01-10", "ATM", 1_000, 0, 99_000)]);
    expect(cash.cashShareBps).toBe(6000);
    expect(cash.flags.find((f) => f.code === "cash_heavy")?.severity).toBe("medium");
  });
  it("three or more bounces are high, and a low balance on most days is noted", () => {
    const s = analyse([
      L("2026-01-01", "UPI/CR/1/KAPPA/HDFC", 0, 5_000, 5_000), L("2026-01-05", "ECS RET CHARGES", 100, 0, 4_900),
      L("2026-01-06", "I/W CHQ RET 1", 100, 0, 4_800), L("2026-01-07", "NACH RETURN CHARGES", 100, 0, 4_700),
    ]);
    expect(s.inwardReturns).toEqual({ count: 3, amount: rs(300) });
    expect(s.flags.find((f) => f.code === "inward_returns")?.severity).toBe("high");
    expect(s.daysLow).toBe(7);
    expect(s.flags.find((f) => f.code === "low_balance")?.severity).toBe("medium");
  });
});

describe("counterparty names", () => {
  it.each([
    ["UPI/CR/412345678901/ACME TRADERS/HDFC/ac@okhdfc", "ACME TRADERS"],
    ["UPI-ACME TRADERS-ac@ybl-HDFC0000001-4123456", "ACME TRADERS"],
    ["NEFT-HDFCN52026101234567-ACME TRADERS PVT LTD-INV 12", "ACME TRADERS PVT LTD"],
    ["NEFT CR-HDFC0000123-ACME TRADERS-ABC", "ACME TRADERS"],
    ["RTGS/UTIBR2026/ACME TRADERS/", "ACME TRADERS"],
    ["IMPS-412345678901-ACME TRADERS-HDFC-9876", "ACME TRADERS"],
  ])("%s", (n, name) => expect(counterparty(n)).toBe(name));
  it("gives nothing for cheques, cash and charges", () => {
    for (const n of ["CHQ DEP 123456", "ATM WDL", "INT.PD 01-01", "SMS CHARGES"]) expect(counterparty(n)).toBeNull();
  });
});
