import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { collectionEvents, invoiceCollections, invoices, ledgerEntries, notifications, repayments, sellerPayouts, unmatchedCredits, users, virtualAccounts } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { prepareAgreements, signInApp } from "../agreements/service";
import { executeDisbursement, fundEscrow, requestDisbursement } from "../disbursements/service";
import { ACCOUNTS, balance } from "../ledger/accounts";
import { delinquencyReport, matchUnmatched, recordIncomingPayment, runCollectionsSweep, runSurplusPayouts, writeOff } from "./service";

let w: Awaited<ReturnType<typeof world>>;
const at = (d: string) => new Date(`${d}T10:00:00Z`);
const admin = { id: "00000000-0000-0000-0000-0000000000a2", role: "admin" };
const ops = { id: "00000000-0000-0000-0000-0000000000a1", role: "ops" };
beforeEach(async () => { w = await world(); });

/** A financed ₹10L invoice (₹9L advance, ₹5k fee, due 2026-11-20). Returns its collection account. */
async function financed() {
  const offer = await w.acceptedOffer();
  await prepareAgreements(w.db, offer, gw, T0);
  await signInApp(w.db, { offerId: offer, actor: w.sellerActor }, T0);
  await fundEscrow(w.db, { amount: 50_00_000_00n, ref: "f", staffId: ops.id, staffRole: "ops" });
  const d = await requestDisbursement(w.db, offer);
  await executeDisbursement(w.db, d.id, gw, T0);
  const [inv] = await w.db.select().from(invoices);
  const [va] = await w.db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, inv.id));
  return { invoiceId: inv.id, account: va.accountNumber };
}
const pay = (account: string, amount: bigint, day: string, utr: string) =>
  recordIncomingPayment(w.db, { accountNumber: account, amount, utr, receivedAt: at(day) }, gw, at(day));
const col = async () => (await w.db.select().from(invoiceCollections))[0];
const status = async () => (await w.db.select().from(invoices))[0].status;
const templates = async () => (await w.db.select().from(notifications)).map((n) => n.template);

describe("financing starts the collections clock", () => {
  it("creates the collection state at disbursement and a unique account number in the notice", async () => {
    const { account } = await financed();
    expect(account).toMatch(/^MARI\d{12}$/);
    expect(await col()).toMatchObject({ principal: 9_00_000_00n, discount: 0n, penal: 0n, lastAccruedOn: "2026-10-06", discountBps: 1200 });
  });
});

describe("recordIncomingPayment", () => {
  it("on-time full payment: waterfall, balanced ledger, invoice paid, surplus owed to seller", async () => {
    const { account } = await financed();
    const r = await pay(account, 10_00_000_00n, "2026-11-20", "UTR1");
    expect(r).toMatchObject({ status: "applied", closed: true, surplus: 86_684_94n }); // ₹10L - ₹9L - ₹13,315.06 discount
    expect(await status()).toBe("paid");
    expect((await w.db.select().from(repayments))[0].allocation).toMatchObject({ principal: "90000000", discount: "1331506", penal: "0" });
    expect(await balance(w.db, ACCOUNTS.receivable(w.sellerId))).toBe(0n); // principal fully recovered
    expect(await balance(w.db, ACCOUNTS.discountIncome)).toBe(-13_315_06n);
    expect(await balance(w.db, ACCOUNTS.sellerPayable(w.sellerId))).toBe(-86_684_94n); // liability to seller
    const net = (await w.db.select().from(ledgerEntries)).reduce((a, e) => a + (e.direction === "debit" ? e.amount : -e.amount), 0n);
    expect(net).toBe(0n);
    expect((await col()).closedAt).toBeTruthy();
    expect(await templates()).toEqual(expect.arrayContaining(["payment_received", "invoice_settled"]));
  });

  it("surplus is paid out of escrow to the seller; the liability clears", async () => {
    const { account } = await financed();
    await pay(account, 10_00_000_00n, "2026-11-20", "UTR1");
    expect(await runSurplusPayouts(w.db, gw)).toBe(1);
    expect(await runSurplusPayouts(w.db, gw)).toBe(0);
    expect(await balance(w.db, ACCOUNTS.sellerPayable(w.sellerId))).toBe(0n);
    expect((await w.db.select().from(sellerPayouts))[0].status).toBe("succeeded");
    // escrow: +₹50L funded, −₹8.95L disbursed, +₹10L collected, −₹86,684.94 surplus paid
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(50_00_000_00n - 8_95_000_00n + 10_00_000_00n - 86_684_94n);
  });

  it("is idempotent on the UTR", async () => {
    const { account } = await financed();
    await pay(account, 5_00_000_00n, "2026-11-01", "UTR-A");
    expect(await pay(account, 5_00_000_00n, "2026-11-01", "UTR-A")).toEqual({ status: "replayed" });
    expect(await w.db.select().from(repayments)).toHaveLength(1);
    expect((await col()).principal).toBe(4_00_000_00n);
  });

  it("partial payments fill principal first, then the rest closes the invoice", async () => {
    const { account } = await financed();
    expect(await pay(account, 5_00_000_00n, "2026-11-01", "U1")).toMatchObject({ status: "applied", closed: false });
    expect(await status()).toBe("financed");
    const mid = await col();
    expect(mid.principal).toBe(4_00_000_00n);
    expect(mid.discount).toBeGreaterThan(0n); // accrued to 1 Nov on the full principal, not yet paid
    const due = mid.principal + mid.discount;
    const later = await pay(account, due + 1_00_000_00n, "2026-11-01", "U2"); // same day, so no new accrual
    expect(later).toMatchObject({ closed: true, surplus: 1_00_000_00n });
    expect(await status()).toBe("paid");
  });

  it("late payment includes penal charges", async () => {
    const { account } = await financed();
    const [row] = await delinquencyReport(w.db, at("2026-12-05"));
    expect(row).toMatchObject({ dpd: 15, bucket: "1-30" });
    expect(row.penal).toBeGreaterThan(0n);
    const r = await pay(account, row.principal + row.discount + row.penal, "2026-12-05", "LATE");
    expect(r).toMatchObject({ closed: true, surplus: 0n });
    expect(await balance(w.db, ACCOUNTS.penalIncome)).toBe(-row.penal);
    expect(await sellerPayoutCount()).toBe(0); // no surplus, no payout
  });

  it("unmatched money is kept for ops: unknown account, not-yet-financed, already settled", async () => {
    expect(await pay("NOPE", 100n, "2026-11-01", "X1")).toEqual({ status: "unmatched", reason: "unknown account" });
    const { account, invoiceId } = await financed();
    await pay(account, 10_00_000_00n, "2026-11-20", "FULL");
    expect(await pay(account, 100n, "2026-11-21", "X2")).toMatchObject({ status: "unmatched", reason: "invoice already settled" });
    expect(await w.db.select().from(unmatchedCredits)).toHaveLength(2);
    expect(await pay(account, 100n, "2026-11-21", "X2")).toEqual({ status: "replayed" });
    void invoiceId;
  });

  it("a credit that arrives before financing is parked, then matched by ops once financed", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0); // creates the collection account, invoice still `eligible`
    const [va] = await w.db.select().from(virtualAccounts);
    expect(await pay(va.accountNumber, 100n, "2026-10-07", "EARLY")).toMatchObject({ status: "unmatched", reason: "invoice not financed yet" });
    const [u] = await w.db.select().from(unmatchedCredits);
    await expect(matchUnmatched(w.db, u.id, va.invoiceId, { id: "x", role: "seller" }, gw)).rejects.toThrow("forbidden");
    await expect(matchUnmatched(w.db, u.id, va.invoiceId, ops, gw)).rejects.toThrow(/not financed/);
    // fund + disburse, then the same credit can be applied
    await signInApp(w.db, { offerId: offer, actor: w.sellerActor }, T0);
    await fundEscrow(w.db, { amount: 20_00_000_00n, ref: "f", staffId: ops.id, staffRole: "ops" });
    await executeDisbursement(w.db, (await requestDisbursement(w.db, offer)).id, gw, T0);
    await matchUnmatched(w.db, u.id, va.invoiceId, ops, gw, at("2026-10-07"));
    expect((await w.db.select().from(unmatchedCredits))[0].resolvedAt).toBeTruthy();
    expect((await col()).principal).toBe(9_00_000_00n - 100n);
  });
});
const sellerPayoutCount = async () => (await w.db.select().from(sellerPayouts)).length;

describe("runCollectionsSweep", () => {
  const kinds = async () => (await w.db.select().from(collectionEvents)).map((e) => e.kind).sort();

  it("reminder ladder, status changes, recourse notice after grace; re-running is a no-op", async () => {
    await financed();
    await w.db.insert(users).values({ name: "Ops", email: "ops@marichi.com", role: "ops" });
    expect((await runCollectionsSweep(w.db, gw, at("2026-11-10"))).events).toBe(0);
    await runCollectionsSweep(w.db, gw, at("2026-11-17")); // 3 days before
    expect(await kinds()).toEqual(["pre_due"]);
    await runCollectionsSweep(w.db, gw, at("2026-11-20"));
    expect(await status()).toBe("due");
    expect(await kinds()).toEqual(["due_today", "pre_due"]);
    await runCollectionsSweep(w.db, gw, at("2026-11-25")); // dpd 5 = still inside grace
    expect(await status()).toBe("due");
    expect(await kinds()).not.toContain("recourse_notice");
    const r = await runCollectionsSweep(w.db, gw, at("2026-11-26")); // dpd 6
    expect(await status()).toBe("overdue");
    expect(await kinds()).toContain("recourse_notice");
    expect((await runCollectionsSweep(w.db, gw, at("2026-11-26"))).events).toBe(0);
    expect(r.events).toBeGreaterThan(0);
    expect((await col()).lastAccruedOn).toBe("2026-11-26");
    expect((await col()).penal).toBeGreaterThan(0n);
    await runCollectionsSweep(w.db, gw, at("2026-12-20")); // dpd 30
    expect(await kinds()).toContain("overdue_30");
    expect(await templates()).toEqual(expect.arrayContaining(["recourse_notice", "collections_escalation"]));
  });

  it("delinquency buckets", async () => {
    await financed();
    for (const [day, bucket] of [["2026-11-20", "0"], ["2026-12-20", "1-30"], ["2027-01-10", "31-60"], ["2027-02-10", "61-90"], ["2027-03-01", "90+"]] as const) {
      expect((await delinquencyReport(w.db, at(day)))[0].bucket).toBe(bucket);
    }
  });
});

describe("writeOff", () => {
  it("admin only, only past 90 days, books the loss and closes the invoice", async () => {
    await financed();
    const id = (await w.db.select().from(invoices))[0].id;
    await expect(writeOff(w.db, id, ops, "x", at("2027-03-01"))).rejects.toThrow("forbidden");
    await expect(writeOff(w.db, id, admin, " ", at("2027-03-01"))).rejects.toThrow(/note/);
    await expect(writeOff(w.db, id, admin, "x", at("2027-01-01"))).rejects.toThrow(/not yet/);
    expect(await writeOff(w.db, id, admin, "borrower insolvent", at("2027-03-01"))).toEqual({ principal: 9_00_000_00n });
    expect(await status()).toBe("written_off");
    expect(await balance(w.db, ACCOUNTS.creditLoss)).toBe(9_00_000_00n);
    expect(await balance(w.db, ACCOUNTS.receivable(w.sellerId))).toBe(0n);
    await expect(writeOff(w.db, id, admin, "again", at("2027-03-02"))).rejects.toThrow(/nothing outstanding/);
  });
});
