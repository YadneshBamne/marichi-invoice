import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { businesses, fraudCases, ledgerAccounts, ledgerEntries } from "../db/schema";
import { assertKybApproved, reviewKyb, submitKyb } from "./service";
import { postEntry } from "../ledger/post";
import type { Database } from "../db/client";

let db: Database;
beforeEach(async () => { db = await testDb(); });

const newBiz = async (legalName = "Acme Traders") =>
  (await db.insert(businesses).values({ legalName, entityType: "pvt_ltd" }).returning())[0].id;
const input = (businessId: string, over: Partial<Parameters<typeof submitKyb>[1]> = {}) => ({
  businessId, pan: "ABCDE1234F",
  ubos: [{ name: "Ravi Kumar", shareholdingBps: 10000 }],
  bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Acme Traders" },
  ...over,
});
const status = async (id: string) => (await db.select().from(businesses).where(eq(businesses.id, id)))[0].kybStatus;

describe("KYB", () => {
  it("auto-approves a clean business and unlocks the financing gate", async () => {
    const id = await newBiz();
    await expect(assertKybApproved(db, id)).rejects.toThrow(/not approved/);
    expect((await submitKyb(db, input(id))).status).toBe("approved");
    await expect(assertKybApproved(db, id)).resolves.toBeUndefined();
  });

  it("sanctions hit goes to review with a compliance case; ops cannot approve it", async () => {
    const id = await newBiz();
    const r = await submitKyb(db, input(id, { ubos: [{ name: "SANCTIONED Person", shareholdingBps: 10000 }] }));
    expect(r.status).toBe("under_review");
    expect(await db.select().from(fraudCases).where(eq(fraudCases.entityId, id))).toHaveLength(1);
    const base = { businessId: id, reviewerId: "00000000-0000-0000-0000-000000000001", decision: "approve" as const, note: "cleared" };
    await expect(reviewKyb(db, { ...base, reviewerRole: "ops" })).rejects.toThrow(/compliance/);
    await expect(reviewKyb(db, { ...base, reviewerRole: "seller" })).rejects.toThrow(/forbidden/);
    expect((await reviewKyb(db, { ...base, reviewerRole: "compliance" })).status).toBe("approved");
  });

  it("invalid PAN requests more info; resubmission is allowed", async () => {
    const id = await newBiz();
    expect((await submitKyb(db, input(id, { pan: "ABCDE1230F" }))).status).toBe("info_requested");
    expect((await submitKyb(db, input(id))).status).toBe("approved");
    expect(await status(id)).toBe("approved");
  });

  it("fails closed when the AML provider errors: stays unapproved", async () => {
    const id = await newBiz();
    const { mock } = await import("../integrations/mock");
    const down = { ...mock, kyc: { ...mock.kyc, screenAml: async () => { throw new Error("provider down"); } } };
    await expect(submitKyb(db, input(id), down)).rejects.toThrow(/provider down/);
    expect(await status(id)).toBe("draft");
  });
});

describe("ledger triggers", () => {
  it("rejects unbalanced inserts at commit, and blocks update/delete", async () => {
    const [a, b] = await db.insert(ledgerAccounts).values([{ code: "a" }, { code: "b" }]).returning();
    const ok = await db.transaction((tx) => postEntry(tx, { ref: "t1", type: "test", lines: [
      { account: "a", direction: "debit", amount: 100n }, { account: "b", direction: "credit", amount: 100n }] }));
    expect(ok.replayed).toBe(false);
    // replay with same ref is a no-op
    expect((await db.transaction((tx) => postEntry(tx, { ref: "t1", type: "test", lines: [
      { account: "a", direction: "debit", amount: 100n }, { account: "b", direction: "credit", amount: 100n }] }))).replayed).toBe(true);
    // bypass the app-level check: raw unbalanced insert must still fail at commit
    await expect(db.transaction(async (tx) => {
      const [t] = await tx.insert((await import("../db/schema")).ledgerTransactions).values({ ref: "bad", type: "x" }).returning();
      await tx.insert(ledgerEntries).values({ transactionId: t.id, accountId: a.id, direction: "debit", amount: 5n });
    })).rejects.toThrow(/unbalanced/);
    const appendOnly = { cause: { message: expect.stringMatching(/append-only/) } }; // drizzle wraps pg errors
    await expect(db.update(ledgerEntries).set({ amount: 1n })).rejects.toMatchObject(appendOnly);
    await expect(db.delete(ledgerEntries)).rejects.toMatchObject(appendOnly);
    void b;
  });
});
