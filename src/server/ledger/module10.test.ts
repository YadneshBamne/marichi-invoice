import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bankStatementLines, disbursements, invoiceCollections, reconciliationRuns } from "../db/schema";
import { gw, world } from "../testkit";
import { recordIncomingPayment, runCollectionsSweep, writeOff } from "../collections/service";
import { fundEscrow } from "../disbursements/service";
import { assertPreviousDayReconciled, reconcileDay, runReconciliation } from "../recon/service";
import type { StatementLine } from "../integrations/gateway";
import { ACCOUNTS, balance } from "./accounts";
import { portfolioXirr, revenueReport, toCsv, trialBalance, generalLedger } from "./reports";
import { splitGst } from "./tax";
import { xirr } from "./xirr";

const at = (d: string) => new Date(`${d}T10:00:00Z`);
const admin = { id: "00000000-0000-0000-0000-0000000000a2", role: "admin" };
let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });

describe("tax", () => {
  it("splits a GST-inclusive fee exactly", () => {
    expect(splitGst(5_000_00n)).toEqual({ base: 4_237_28n, gst: 762_72n });
    for (const f of [1n, 99n, 118n, 12345n, 999_999n]) { const s = splitGst(f); expect(s.base + s.gst).toBe(f); }
  });
});

describe("xirr", () => {
  it("one year, 10%", () => {
    expect(xirr([{ date: "2021-01-01", amount: -1000 }, { date: "2022-01-01", amount: 1100 }])!).toBeCloseTo(0.1, 6);
  });
  it("irregular flows: the root zeroes the NPV", () => {
    const flows = [{ date: "2021-01-01", amount: -1000 }, { date: "2021-07-02", amount: 600 }, { date: "2022-01-01", amount: 500 }];
    const r = xirr(flows)!;
    const npv = flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (Date.parse(f.date) - Date.parse("2021-01-01")) / 86_400_000 / 365), 0);
    expect(Math.abs(npv)).toBeLessThan(1e-6);
  });
  it("undefined without both an outflow and an inflow", () => {
    expect(xirr([{ date: "2021-01-01", amount: -1 }])).toBeNull();
    expect(xirr([{ date: "2021-01-01", amount: 1 }, { date: "2021-02-01", amount: 2 }])).toBeNull();
  });
});

describe("toCsv", () => {
  it("quotes and neutralises spreadsheet formulas", () => {
    expect(toCsv([["a", 'b,"c"', 12n, "=SUM(A1)", "-5", "@x"]])).toBe(`a,"b,""c""",12,'=SUM(A1),'-5,'@x\r\n`);
  });
});

describe("daily discount accrual in the ledger", () => {
  it("books income as it accrues; the accrued receivable always equals the collection state", async () => {
    await w.financed();
    await runCollectionsSweep(w.db, gw, at("2026-11-20"));
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBe(-13_315_06n);
    expect(await balance(w.db, ACCOUNTS.accruedDiscount)).toBe(13_315_06n);
    await runCollectionsSweep(w.db, gw, at("2026-11-20")); // same day again: no double count
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBe(-13_315_06n);
    const state = (await w.db.select().from(invoiceCollections))[0];
    expect(state.discount).toBe(await balance(w.db, ACCOUNTS.accruedDiscount));
  });

  it("collecting clears the receivable without booking income twice", async () => {
    const f = await w.financed();
    await runCollectionsSweep(w.db, gw, at("2026-11-20"));
    await recordIncomingPayment(w.db, { accountNumber: f.account, amount: 10_00_000_00n, utr: "U1", receivedAt: at("2026-11-20") }, gw, at("2026-11-20"));
    expect(await balance(w.db, ACCOUNTS.accruedDiscount)).toBe(0n);
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBe(-13_315_06n);
  });

  it("write-off reverses the uncollected accrued discount out of income", async () => {
    const f = await w.financed();
    await runCollectionsSweep(w.db, gw, at("2027-03-01"));
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBeLessThan(0n);
    await writeOff(w.db, f.invoiceId, admin, "insolvent", at("2027-03-01"));
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBe(0n);
    expect(await balance(w.db, ACCOUNTS.accruedDiscount)).toBe(0n);
    expect(await balance(w.db, ACCOUNTS.creditLoss)).toBe(9_00_000_00n);
  });
});

describe("reports", () => {
  it("trial balance balances; revenue and XIRR come straight from the books", async () => {
    const f = await w.financed();
    await recordIncomingPayment(w.db, { accountNumber: f.account, amount: 10_00_000_00n, utr: "U1", receivedAt: at("2026-11-20") }, gw, at("2026-11-20"));
    const tb = await trialBalance(w.db);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.escrow)!.balance).toBe(await balance(w.db, ACCOUNTS.escrow));
    expect((await trialBalance(w.db, new Date("2000-01-01"))).rows.every((r) => r.balance === 0n)).toBe(true); // nothing before time began

    const rev = await revenueReport(w.db, "2000-01-01", "2100-01-01");
    expect(rev).toMatchObject({ feeIncome: 4_237_28n, gstCollected: 762_72n, discountIncome: 13_315_06n, penalIncome: 0n, creditLoss: 0n });
    expect(rev.netRevenue).toBe(4_237_28n + 13_315_06n);

    const y = await portfolioXirr(w.db);
    const expected = Math.pow((9_00_000_00 + 13_315_06) / 8_95_000_00, 365 / 45) - 1; // out ₹8.95L, in principal + discount 45 days later
    expect(y.xirr).toBeCloseTo(expected, 4);

    const gl = await generalLedger(w.db, "2000-01-01", "2100-01-01");
    expect(gl.length).toBeGreaterThan(5);
    expect(gl.reduce((a, l) => a + BigInt(l.debit) - BigInt(l.credit), 0n)).toBe(0n);
  });
});

describe("bank reconciliation", () => {
  const today = new Date().toISOString().slice(0, 10); // ledger timestamps are real DB time
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const feed = (lines: StatementLine[]) => ({ ...gw, statements: { fetch: async () => lines } });
  const bankRefOf = async () => (await w.db.select().from(disbursements))[0].bankRef!;
  const lines = async (opts: { skipPayout?: boolean; payoutAmount?: bigint; extra?: StatementLine[] } = {}): Promise<StatementLine[]> => [
    { reference: `fund-${(await w.db.select().from(disbursements))[0].offerId}`, direction: "credit", amount: 50_00_000_00n },
    ...(opts.skipPayout ? [] : [{ reference: await bankRefOf(), direction: "debit" as const, amount: opts.payoutAmount ?? 8_95_000_00n }]),
    ...(opts.extra ?? []),
  ];
  // funding ref in the ledger is `fund:<ref>`, so the bank narration must carry that exact reference
  const fixFundRef = (l: StatementLine[]) => l.map((x) => (x.reference.startsWith("fund-") ? { ...x, reference: `fund:${x.reference}` } : x));

  it("ties out when every bank line matches the ledger and vice versa", async () => {
    await w.financed();
    const run = await runReconciliation(w.db, today, feed(fixFundRef(await lines())));
    expect(run).toMatchObject({ status: "tied", variance: 0n, bankNet: 50_00_000_00n - 8_95_000_00n });
    expect((await w.db.select().from(bankStatementLines)).every((l) => l.status === "matched")).toBe(true);
    expect((await runReconciliation(w.db, today, feed(fixFundRef(await lines())))).status).toBe("tied"); // re-runnable
  });

  it("flags a payout missing from the bank, then ties once it appears", async () => {
    await w.financed();
    const first = await runReconciliation(w.db, today, feed(fixFundRef(await lines({ skipPayout: true }))));
    expect(first.status).toBe("variance");
    expect(first.variance).toBe(8_95_000_00n); // bank shows more cash than the ledger says should remain
    expect((first.exceptions as { kind: string }[]).map((e) => e.kind)).toEqual(["missing_in_bank"]);
    expect((await runReconciliation(w.db, today, feed(fixFundRef(await lines())))).status).toBe("tied");
  });

  it("flags amount mismatches and bank lines with no ledger entry", async () => {
    await w.financed();
    const bad = fixFundRef(await lines({ payoutAmount: 8_94_000_00n, extra: [{ reference: "UTR-X", direction: "credit", amount: 123n }] }));
    const run = await runReconciliation(w.db, today, feed(bad));
    expect(run.status).toBe("variance");
    expect((run.exceptions as { kind: string }[]).map((e) => e.kind).sort()).toEqual(["amount_mismatch", "no_ledger_entry"]);
    expect((await w.db.select().from(bankStatementLines)).filter((l) => l.status === "exception")).toHaveLength(2);
  });

  it("gate: next day stays closed until the previous day ties (only when RECON_GATE=on)", async () => {
    await w.financed();
    await expect(assertPreviousDayReconciled(w.db, tomorrow)).resolves.toBeUndefined(); // gate off by default
    process.env.RECON_GATE = "on";
    try {
      await expect(assertPreviousDayReconciled(w.db, tomorrow)).rejects.toThrow("RECONCILIATION_REQUIRED");
      await reconcileDay(w.db, today); // no statement lines ingested: variance
      await expect(assertPreviousDayReconciled(w.db, tomorrow)).rejects.toThrow(/unresolved variance/);
      await runReconciliation(w.db, today, feed(fixFundRef(await lines())));
      await expect(assertPreviousDayReconciled(w.db, tomorrow)).resolves.toBeUndefined();
      await expect(assertPreviousDayReconciled(w.db, "2020-01-02")).resolves.toBeUndefined(); // no movement that day => nothing to reconcile
    } finally { delete process.env.RECON_GATE; }
    expect((await w.db.select().from(reconciliationRuns)).length).toBe(1);
  });

  it("funding and balances still agree with the ledger", async () => {
    await fundEscrow(w.db, { amount: 100n, ref: "x", staffId: admin.id, staffRole: "admin" });
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(100n);
    expect(eq).toBeDefined();
  });
});
