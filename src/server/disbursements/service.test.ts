import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { disbursements, invoices, ledgerEntries, notifications, users } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { prepareAgreements, signInApp } from "../agreements/service";
import { balance, ACCOUNTS } from "../ledger/accounts";
import { mock } from "../integrations/mock";
import type { Rail } from "../integrations/gateway";
import {
  approveDisbursement, executeDisbursement, fundEscrow, pollProcessing, railPlan, requestDisbursement, retryDisbursement,
  runDisbursements, settleDisbursement,
} from "./service";

let w: Awaited<ReturnType<typeof world>>;
const ops = { id: "00000000-0000-0000-0000-0000000000a1", role: "ops" };
const admin = { id: "00000000-0000-0000-0000-0000000000a2", role: "admin" };
beforeEach(async () => { w = await world(); });

/** Accepted + fully signed offer; ₹10L invoice => ₹9L advance, ₹5k fee => ₹8,95,000 payout. */
async function signedOffer(amount?: bigint) {
  const offer = await w.acceptedOffer(amount);
  await prepareAgreements(w.db, offer, gw, T0);
  await signInApp(w.db, { offerId: offer, actor: w.sellerActor }, T0);
  return offer;
}
const fund = (amount: bigint, ref = "f1") => fundEscrow(w.db, { amount, ref, staffId: ops.id, staffRole: "ops" });
const row = async (offer: string) => (await w.db.select().from(disbursements).where(eq(disbursements.offerId, offer)))[0];

// A provider that fails for the listed rails and otherwise succeeds, recording every call.
const calls: { key: string; rail: Rail }[] = [];
const provider = (failRails: Rail[] = [], mode: "succeeded" | "processing" = "succeeded") => ({
  ...gw,
  payments: {
    ...gw.payments,
    payout: async (p: { idempotencyKey: string; rail: Rail }) => {
      calls.push({ key: p.idempotencyKey, rail: p.rail });
      if (failRails.includes(p.rail)) return { bankRef: `X-${p.idempotencyKey}`, status: "failed" as const, reason: `${p.rail} down` };
      return { bankRef: `BANK-${p.idempotencyKey}`, status: mode };
    },
    payoutStatus: async () => "succeeded" as const,
  },
});
beforeEach(() => { calls.length = 0; });

describe("railPlan", () => {
  it("small => IMPS then NEFT; large => RTGS then NEFT", () => {
    expect(railPlan(1_00_000_00n)).toEqual(["IMPS", "NEFT"]);
    expect(railPlan(5_00_000_00n)).toEqual(["IMPS", "NEFT"]);
    expect(railPlan(5_00_000_01n)).toEqual(["RTGS", "NEFT"]);
  });
});

describe("requestDisbursement", () => {
  it("needs signed agreements and a verified bank account; one per offer", async () => {
    const unsigned = await w.acceptedOffer();
    await expect(requestDisbursement(w.db, unsigned)).rejects.toThrow(/AGREEMENTS_INCOMPLETE/);
    const offer = await signedOffer();
    const d = await requestDisbursement(w.db, offer);
    expect(d).toMatchObject({ amount: 8_95_000_00n, status: "pending", needsApproval: false });
    expect((await requestDisbursement(w.db, offer)).id).toBe(d.id);
    expect(await w.db.select().from(disbursements)).toHaveLength(1);
  });

  it("blocks when the invoice got disputed after signing", async () => {
    const offer = await signedOffer();
    await w.db.update(invoices).set({ disputeFlag: true });
    await expect(requestDisbursement(w.db, offer)).rejects.toThrow(/cannot be funded/);
  });
});

describe("executeDisbursement", () => {
  it("pays out, posts balanced ledger entries, marks the invoice financed, notifies the seller", async () => {
    const offer = await signedOffer();
    await fund(20_00_000_00n);
    const d = await requestDisbursement(w.db, offer);
    expect(await executeDisbursement(w.db, d.id, provider(), T0)).toEqual({ status: "succeeded" });
    expect(calls).toEqual([{ key: `disb:${offer}:0`, rail: "RTGS" }]); // ₹8.95L > ₹5L => RTGS
    expect(await row(offer)).toMatchObject({ status: "succeeded", rail: "RTGS", bankRef: `BANK-disb:${offer}:0` });
    expect((await w.db.select().from(invoices))[0].status).toBe("financed");
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(20_00_000_00n - 8_95_000_00n);
    expect(await balance(w.db, ACCOUNTS.receivable(w.sellerId))).toBe(9_00_000_00n); // full advance is owed back
    expect(await balance(w.db, ACCOUNTS.feeIncome)).toBe(-4_237_28n); // ₹5,000 fee is GST-inclusive: base ₹4,237.28...
    expect(await balance(w.db, ACCOUNTS.gstPayable)).toBe(-762_72n); // ...plus ₹762.72 GST payable
    const net = (await w.db.select().from(ledgerEntries)).reduce((a, e) => a + (e.direction === "debit" ? e.amount : -e.amount), 0n);
    expect(net).toBe(0n);
    expect((await w.db.select().from(notifications)).some((n) => n.template === "disbursed")).toBe(true);
  });

  it("is idempotent: executing again neither pays twice nor double-posts", async () => {
    const offer = await signedOffer();
    await fund(20_00_000_00n);
    const d = await requestDisbursement(w.db, offer);
    await executeDisbursement(w.db, d.id, provider(), T0);
    expect(await executeDisbursement(w.db, d.id, provider(), T0)).toEqual({ status: "succeeded" });
    expect(calls).toHaveLength(1);
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(20_00_000_00n - 8_95_000_00n);
  });

  it("will not send money that isn't in escrow", async () => {
    const offer = await signedOffer();
    const d = await requestDisbursement(w.db, offer);
    await expect(executeDisbursement(w.db, d.id, provider(), T0)).rejects.toThrow("ESCROW_INSUFFICIENT");
    expect(calls).toHaveLength(0);
    expect((await row(offer)).status).toBe("pending");
    await fund(8_95_000_00n);
    expect(await executeDisbursement(w.db, d.id, provider(), T0)).toEqual({ status: "succeeded" });
  });

  it("reserves in-flight payouts so two payouts can't spend the same escrow cash", async () => {
    const o1 = await signedOffer(), o2 = await signedOffer();
    await fund(10_00_000_00n); // enough for one ₹8.95L payout, not two
    const d1 = await requestDisbursement(w.db, o1), d2 = await requestDisbursement(w.db, o2);
    expect(await executeDisbursement(w.db, d1.id, provider([], "processing"), T0)).toEqual({ status: "processing" });
    await expect(executeDisbursement(w.db, d2.id, provider(), T0)).rejects.toThrow("ESCROW_INSUFFICIENT");
  });

  it("maker-checker: > ₹10L cannot be sent until a different staff member approves", async () => {
    const offer = await signedOffer(13_00_000_00n); // ₹11.7L advance - fee => above threshold
    await fund(50_00_000_00n);
    const d = await requestDisbursement(w.db, offer, ops.id);
    expect(d.needsApproval).toBe(true);
    await expect(executeDisbursement(w.db, d.id, provider(), T0)).rejects.toThrow("APPROVAL_REQUIRED");
    await expect(approveDisbursement(w.db, d.id, ops)).rejects.toThrow(/maker cannot approve/);
    await expect(approveDisbursement(w.db, d.id, { id: ops.id, role: "seller" })).rejects.toThrow("forbidden");
    await approveDisbursement(w.db, d.id, admin, T0);
    await expect(approveDisbursement(w.db, d.id, admin)).rejects.toThrow(/already approved/);
    expect(await executeDisbursement(w.db, d.id, provider(), T0)).toEqual({ status: "succeeded" });
    expect(calls[0].rail).toBe("RTGS");
  });
});

describe("failures and retries", () => {
  it("primary rail fails -> worker retries on NEFT with a fresh key; money moves once", async () => {
    const offer = await signedOffer();
    await fund(20_00_000_00n);
    const p = provider(["RTGS"]);
    expect(await runDisbursements(w.db, p)).toBe(0); // RTGS fails
    expect(await row(offer)).toMatchObject({ status: "failed", attempts: 1, failureReason: "RTGS down" });
    expect(await runDisbursements(w.db, p)).toBe(1); // NEFT succeeds
    expect(calls.map((c) => `${c.rail}:${c.key.split(":").pop()}`)).toEqual(["RTGS:0", "NEFT:1"]);
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(20_00_000_00n - 8_95_000_00n);
    expect((await w.db.select().from(invoices))[0].status).toBe("financed");
  });

  it("both rails fail -> stops auto-retrying, alerts ops; ops retry re-queues", async () => {
    const offer = await signedOffer();
    await fund(20_00_000_00n);
    await w.db.insert(users).values({ name: "Ops", email: "ops@marichi.com", role: "ops" });
    const down = provider(["RTGS", "NEFT"]);
    await runDisbursements(w.db, down); await runDisbursements(w.db, down);
    expect(await row(offer)).toMatchObject({ status: "failed", attempts: 2 });
    await runDisbursements(w.db, down); // no further automatic attempts
    expect(calls).toHaveLength(2);
    expect((await w.db.select().from(notifications)).some((n) => n.template === "disbursement_needs_attention")).toBe(true);
    await retryDisbursement(w.db, (await row(offer)).id, ops);
    expect(await runDisbursements(w.db, provider())).toBe(1);
    expect(calls.at(-1)!.key).toBe(`disb:${offer}:2`); // a never-before-used key
  });

  it("async payouts settle via webhook or poller, and replays are harmless", async () => {
    const offer = await signedOffer();
    await fund(20_00_000_00n);
    const d = await requestDisbursement(w.db, offer);
    expect(await executeDisbursement(w.db, d.id, provider([], "processing"), T0)).toEqual({ status: "processing" });
    expect((await row(offer)).status).toBe("processing");
    expect(await pollProcessing(w.db, provider())).toBe(1); // poller finds it succeeded
    expect(await settleDisbursement(w.db, `BANK-disb:${offer}:0`, "succeeded")).toEqual({ status: "succeeded" }); // late webhook
    await expect(settleDisbursement(w.db, "nope", "succeeded")).rejects.toThrow(/unknown/);
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(20_00_000_00n - 8_95_000_00n);
  });

  it("a failed webhook outcome frees the escrow reservation and allows a retry", async () => {
    const offer = await signedOffer();
    await fund(20_00_000_00n);
    const d = await requestDisbursement(w.db, offer);
    await executeDisbursement(w.db, d.id, provider([], "processing"), T0);
    await settleDisbursement(w.db, `BANK-disb:${offer}:0`, "failed", "beneficiary bank rejected", gw);
    expect(await row(offer)).toMatchObject({ status: "failed", attempts: 1 });
    expect(await runDisbursements(w.db, provider())).toBe(1);
  });
});

describe("fundEscrow", () => {
  it("staff only, positive amounts, idempotent by ref", async () => {
    await expect(fundEscrow(w.db, { amount: 100n, ref: "x", staffId: ops.id, staffRole: "seller" })).rejects.toThrow("forbidden");
    await expect(fundEscrow(w.db, { amount: 0n, ref: "x", staffId: ops.id, staffRole: "ops" })).rejects.toThrow(/positive/);
    await fund(500n, "same"); await fund(500n, "same");
    expect(await balance(w.db, ACCOUNTS.escrow)).toBe(500n);
  });
});

void mock;
