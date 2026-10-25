import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, invoices, limitReviews, notifications } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { decide, POLICY, type Inputs } from "./policy";
import { reviewLimit, rescoreLimits } from "./rescore";
import { createInvoice } from "../invoices/service";
import { underwriteInvoice } from "./service";
import { resetPolicyForTests } from "../config/policy";
import { mock } from "../integrations/mock";

afterEach(() => resetPolicyForTests());
const L = 1_00_000_00n;

const party = { bureauScore: 780, paidCount: 5, overdueCount: 0, maxDpd: 0 };
const base = (c?: Inputs["concentration"]): Inputs => ({
  invoiceAmount: 5n * L, tenorDays: 45, irnStatus: "verified",
  seller: { ...party, outstanding: 0n, limit: 100n * L }, buyer: { ...party, outstandingForSeller: 0n, cap: 100n * L }, concentration: c,
});

describe("platform concentration limits", () => {
  it("too much already outstanding to one buyer, or in one industry, sends the invoice to an analyst instead of approving it", () => {
    expect(decide(base()).decision).toBe("approved");
    expect(decide(base({ buyerTotal: 10n * L, sector: "Textiles", sectorTotal: 10n * L })).decision).toBe("approved"); // inside both limits
    const buyer = decide(base({ buyerTotal: POLICY.maxBuyerExposure, sector: null, sectorTotal: 0n }));
    expect(buyer.decision).toBe("referred");
    expect(buyer.reasons.map((r) => r.code)).toContain("BUYER_CONCENTRATION");
    expect(buyer.reasons.map((r) => r.code)).not.toContain("MANUAL_REVIEW");
    const sector = decide(base({ buyerTotal: 0n, sector: "Textiles", sectorTotal: POLICY.maxSectorExposure }));
    expect(sector.decision).toBe("referred");
    expect(sector.reasons.find((r) => r.code === "SECTOR_CONCENTRATION")?.text).toMatch(/Textiles/);
    expect(decide(base({ buyerTotal: 0n, sector: null, sectorTotal: POLICY.maxSectorExposure })).decision).toBe("approved"); // no industry named: no sector rule
  });

  it("is measured across all sellers from the real book, when underwriting", async () => {
    const w = await world();
    await w.db.update(businesses).set({ industry: "Textiles" }).where(eq(businesses.id, w.sellerId));
    await w.financed(10n * L); // 10 lakh outstanding to this buyer and in this industry
    POLICY.maxBuyerExposure = 15n * L; POLICY.maxSectorExposure = 1000n * L;
    const next = async (n: string) => (await createInvoice(w.db, { sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: n, invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10n * L, contentHash: `h-${n}`, irn: `IRN-OK-${n}` }, mock, T0)).id;
    const id1 = await next("C-1");
    await w.db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id1));
    const d1 = await underwriteInvoice(w.db, id1, gw, T0);
    expect(d1.decision).toBe("referred");
    expect((d1.reasons as { code: string }[]).map((r) => r.code)).toContain("BUYER_CONCENTRATION");
    POLICY.maxBuyerExposure = 1000n * L; POLICY.maxSectorExposure = 15n * L;
    const id2 = await next("C-2");
    await w.db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id2));
    expect((await underwriteInvoice(w.db, id2, gw, T0)).reasons as { code: string }[]).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SECTOR_CONCENTRATION" })]));
  }, 60_000);
});

describe("the limit review rule", () => {
  const r = (o: Partial<Parameters<typeof reviewLimit>[0]> = {}) => reviewLimit({ current: 100n * L, outstanding: 20n * L, paidCount: 0, overdueCount: 0, maxDpd: 0, ...o });
  it("a late payment lowers it, a serious one lowers it more, and it never drops below what is already out", () => {
    expect(r({ overdueCount: 1, maxDpd: 5 })).toMatchObject({ next: 75n * L, reason: "Lowered: an invoice is overdue" });
    expect(r({ overdueCount: 1, maxDpd: 45 })).toMatchObject({ next: 50n * L });
    expect(r({ overdueCount: 1, maxDpd: 45 }).reason).toMatch(/45 days late/);
    expect(r({ maxDpd: 999, overdueCount: 1 }).reason).toMatch(/written off/);
    expect(r({ overdueCount: 1, maxDpd: 5, outstanding: 90n * L }).next).toBe(90n * L);
  });
  it("a clean record with a well-used limit raises it, up to a ceiling; otherwise nothing changes", () => {
    expect(r({ paidCount: 3, outstanding: 60n * L })).toMatchObject({ next: 125n * L });
    expect(r({ paidCount: 3, outstanding: 60n * L }).reason).toMatch(/3 invoices repaid on time and 60% of the limit is in use/);
    expect(r({ paidCount: 3, outstanding: 10n * L }).next).toBe(100n * L); // barely used
    expect(r({ paidCount: 2, outstanding: 60n * L }).next).toBe(100n * L); // too little history
    const top = POLICY.defaultSellerLimit * BigInt(POLICY.maxLimitMultiple);
    expect(r({ current: top, paidCount: 9, outstanding: top }).next).toBe(top);
  });
});

describe("reviewing sellers' limits on a schedule", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => { w = await world(); });
  const later = (days: number) => new Date(Date.now() + days * 86_400_000);

  it("a seller is not reviewed until a full period has passed; then it is, once, and the date is kept even when nothing changes", async () => {
    expect(await rescoreLimits(w.db, gw, later(5))).toEqual({ reviewed: 0, raised: 0, lowered: 0 });
    expect(await rescoreLimits(w.db, gw, later(31))).toEqual({ reviewed: 1, raised: 0, lowered: 0 });
    const [rev] = await w.db.select().from(limitReviews);
    expect(rev).toMatchObject({ before: POLICY.defaultSellerLimit, after: POLICY.defaultSellerLimit, reason: "No change" });
    expect(await rescoreLimits(w.db, gw, later(35))).toMatchObject({ reviewed: 0 }); // reviewed 4 days ago
    expect(await rescoreLimits(w.db, gw, later(62))).toMatchObject({ reviewed: 1 });
  });

  it("an overdue invoice lowers the limit, writes it to the seller, tells the seller why, and a clean well-used record raises it", async () => {
    const f = await w.financed(10n * L);
    const reviewDay = later(40);
    await w.db.update(invoices).set({ status: "overdue", dueDate: new Date(reviewDay.getTime() - 5 * 86_400_000).toISOString().slice(0, 10) }).where(eq(invoices.id, f.invoiceId)); // five days late
    expect(await rescoreLimits(w.db, gw, reviewDay)).toEqual({ reviewed: 1, raised: 0, lowered: 1 });
    const lowered = (await w.db.select().from(businesses).where(eq(businesses.id, w.sellerId)))[0].creditLimit;
    expect(lowered).toBe(75n * (POLICY.defaultSellerLimit / 100n));
    expect((await w.db.select().from(notifications)).some((n) => n.template === "limit_changed" && /overdue/.test(n.body ?? ""))).toBe(true);

    // three repaid invoices and a limit that is in use
    for (let i = 0; i < 3; i++) await w.financed(10n * L).then((x) => w.db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, x.invoiceId)));
    await w.db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, f.invoiceId));
    const last = await w.financed(10n * L);
    await w.db.update(invoices).set({ dueDate: later(120).toISOString().slice(0, 10) }).where(eq(invoices.id, last.invoiceId)); // still comfortably within its term
    await w.db.update(businesses).set({ creditLimit: 15n * L }).where(eq(businesses.id, w.sellerId));
    expect(await rescoreLimits(w.db, gw, later(80))).toEqual({ reviewed: 1, raised: 1, lowered: 0 });
    expect((await w.db.select().from(businesses).where(eq(businesses.id, w.sellerId)))[0].creditLimit).toBe(18n * L + 75_000_00n); // 15 lakh + 25%, to whole thousands
  }, 120_000);
});
