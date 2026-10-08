import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { businesses, invoices, underwritingDecisions } from "../db/schema";
import { submitKyb, submitLightKyb } from "../kyb/service";
import { linkBuyer } from "../relationships/service";
import { createInvoice } from "../invoices/service";
import { mock } from "../integrations/mock";
import { pendingReviews, recordConsent, reviewUnderwriting, underwriteEligible, underwriteInvoice } from "./service";
import type { Database } from "../db/client";

const T0 = new Date("2026-10-06T00:00:00Z");
let db: Database, sellerId: string, buyerId: string;
let score = 780;
const gw = { ...mock, bureau: { pull: async () => ({ score, noHit: false }) } };

beforeEach(async () => {
  score = 780;
  db = await testDb();
  sellerId = (await db.insert(businesses).values({ legalName: "Seller Co", entityType: "pvt_ltd" }).returning())[0].id;
  buyerId = (await db.insert(businesses).values({ legalName: "Big Corp", entityType: "pvt_ltd" }).returning())[0].id;
  await submitKyb(db, {
    businessId: sellerId, pan: "ABCDE1234F", gstin: "27AAAAA1111A1Z5", ubos: [{ name: "Ravi", shareholdingBps: 10000 }],
    bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Seller Co" },
  });
  await submitLightKyb(db, { businessId: buyerId, gstin: "29BBBBB2222B1Z5", pan: "BCDEF2345G" });
  await linkBuyer(db, { sellerId, buyerGstin: "29BBBBB2222B1Z5", buyerEmail: "ap@big.com" });
  await recordConsent(db, { businessId: sellerId, text: "I authorise credit checks" });
  await recordConsent(db, { businessId: buyerId, text: "I authorise credit checks" });
});

let n = 0;
async function eligibleInvoice(amount = 5_00_000_00n, irn?: string) {
  const { id } = await createInvoice(db, {
    sellerId, buyerId, invoiceNumber: `INV-${++n}`, invoiceDate: "2026-09-25", dueDate: "2026-11-20",
    amount, contentHash: `h${n}`, irn,
  }, mock, T0);
  await db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id)); // as Module 4 does on confirmation
  return id;
}

describe("underwriteInvoice", () => {
  it("persists an explainable decision with an input snapshot, and is idempotent", async () => {
    const id = await eligibleInvoice(5_00_000_00n, "IRN-OK");
    const d = await underwriteInvoice(db, id, gw, T0);
    expect(d).toMatchObject({ decision: "approved", riskGrade: "A", advanceRateBps: 9000, decidedBy: "rules-v1" });
    expect((d.inputs as { seller: { bureauScore: number } }).seller.bureauScore).toBe(780);
    expect(((d.reasons as { code: string }[])[0]).code).toBe("GRADE");
    expect((await underwriteInvoice(db, id, gw, T0)).id).toBe(d.id);
    expect(await db.select().from(underwritingDecisions)).toHaveLength(1);
  });

  it("no IRN lowers the advance", async () => {
    const d = await underwriteInvoice(db, await eligibleInvoice(), gw, T0);
    expect(d.advanceRateBps).toBe(8500);
  });

  it("refuses non-eligible invoices and missing seller consent", async () => {
    const id = await eligibleInvoice();
    await db.update(invoices).set({ status: "disputed" }).where(eq(invoices.id, id));
    await expect(underwriteInvoice(db, id, gw, T0)).rejects.toThrow(/not eligible/);
    await db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id));
    await db.delete((await import("../db/schema")).consents).where(eq((await import("../db/schema")).consents.businessId, sellerId));
    await expect(underwriteInvoice(db, id, gw, T0)).rejects.toThrow("CONSENT_REQUIRED");
  });

  it("bureau outage: no decision is made, and a later retry succeeds", async () => {
    const id = await eligibleInvoice();
    const down = { ...mock, bureau: { pull: async () => { throw new Error("bureau down"); } } };
    await expect(underwriteInvoice(db, id, down, T0)).rejects.toThrow("bureau down");
    expect(await db.select().from(underwritingDecisions)).toHaveLength(0);
    expect((await underwriteInvoice(db, id, gw, T0)).decision).toBe("approved");
  });

  it("low bureau score declines", async () => {
    score = 500;
    const d = await underwriteInvoice(db, await eligibleInvoice(), gw, T0);
    expect(d).toMatchObject({ decision: "declined", riskGrade: "E" });
  });

  it("counts already-outstanding invoices against the buyer cap", async () => {
    // 9 x ₹5L financed already = ₹45L outstanding; a ₹6L invoice breaches the ₹50L default cap
    for (let k = 0; k < 9; k++) {
      await db.insert(invoices).values({
        sellerId, buyerId, invoiceNumber: `OLD-${k}`, invoiceDate: "2026-09-01", dueDate: "2026-11-30",
        amount: 5_00_000_00n, contentHash: `old${k}`, status: "financed",
      });
    }
    const d = await underwriteInvoice(db, await eligibleInvoice(6_00_000_00n), gw, T0);
    expect(d).toMatchObject({ decision: "declined" });
    expect((d.reasons as { code: string }[])[0].code).toBe("BUYER_CAP");
  });

  it("underwriteEligible sweeps undecided invoices and skips failures", async () => {
    await eligibleInvoice(); await eligibleInvoice();
    expect(await underwriteEligible(db, gw)).toBe(2);
  });
});

describe("manual review", () => {
  const referred = async () => {
    return underwriteInvoice(db, await eligibleInvoice(30_00_000_00n), gw, T0); // above grade A's ₹25L auto limit
  };
  const rev = { reviewerId: "00000000-0000-0000-0000-000000000009", note: "checked financials" };

  it("refers big tickets; ops approves with a note; others cannot", async () => {
    const d = await referred();
    expect(d.decision).toBe("referred");
    expect(await pendingReviews(db)).toHaveLength(1);
    await expect(reviewUnderwriting(db, { decisionId: d.id, reviewerRole: "seller", outcome: "approve", ...rev })).rejects.toThrow("forbidden");
    await expect(reviewUnderwriting(db, { decisionId: d.id, reviewerRole: "ops", outcome: "approve", ...rev, note: " " })).rejects.toThrow(/note/);
    expect(await reviewUnderwriting(db, { decisionId: d.id, reviewerRole: "ops", outcome: "approve", ...rev })).toEqual({ decision: "approved" });
    const [row] = await db.select().from(underwritingDecisions).where(eq(underwritingDecisions.id, d.id));
    expect(row).toMatchObject({ decision: "approved", decidedBy: `manual:${rev.reviewerId}` });
    await expect(reviewUnderwriting(db, { decisionId: d.id, reviewerRole: "ops", outcome: "decline", ...rev })).rejects.toThrow(/nothing to review/);
  });
});
