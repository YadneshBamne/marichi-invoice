import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mlScores, underwritingDecisions } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { createInvoice } from "../invoices/service";
import { mock } from "../integrations/mock";
import { invoices } from "../db/schema";
import { underwriteInvoice } from "./service";
import { assist, features, gradeGap, gradeOfPd, ML, scoreWithModel } from "./ml";
import { decide, type Inputs } from "./policy";
import { modelReport } from "./ml-report";

const good: Inputs = {
  invoiceAmount: 5_00_000_00n, tenorDays: 45, irnStatus: "verified",
  seller: { bureauScore: 780, paidCount: 6, overdueCount: 0, maxDpd: 0, outstanding: 5_00_000_00n, limit: 1_00_00_000_00n },
  buyer: { bureauScore: 790, paidCount: 8, overdueCount: 0, maxDpd: 0, outstandingForSeller: 5_00_000_00n, cap: 50_00_000_00n },
};
const weak: Inputs = {
  invoiceAmount: 40_00_000_00n, tenorDays: 110, irnStatus: "absent",
  seller: { bureauScore: 560, paidCount: 0, overdueCount: 1, maxDpd: 20, outstanding: 80_00_000_00n, limit: 1_00_00_000_00n },
  buyer: { bureauScore: 580, paidCount: 0, overdueCount: 1, maxDpd: 10, outstandingForSeller: 8_00_000_00n, cap: 50_00_000_00n },
};
const ml0 = ML.mode;
afterEach(() => { ML.mode = ml0; });

describe("scoring model", () => {
  it("rates strong parties low and weak, stretched ones high, with the probability in range", () => {
    const g = scoreWithModel(good), w = scoreWithModel(weak);
    expect(g.pd).toBeGreaterThan(0); expect(g.pd).toBeLessThan(0.025); expect(["A", "B"]).toContain(g.grade);
    expect(w.pd).toBeGreaterThan(0.1); expect(w.pd).toBeLessThanOrEqual(1); expect(["D", "E"]).toContain(w.grade);
    expect(w.pd).toBeGreaterThan(g.pd * 5);
  });

  it("moves the right way: a better buyer score lowers risk, more overdue raises it", () => {
    const base = scoreWithModel(good).pd;
    expect(scoreWithModel({ ...good, buyer: { ...good.buyer, bureauScore: 600 } }).pd).toBeGreaterThan(base);
    expect(scoreWithModel({ ...good, buyer: { ...good.buyer, overdueCount: 2 } }).pd).toBeGreaterThan(base);
    expect(scoreWithModel({ ...good, irnStatus: "absent" }).pd).toBeGreaterThan(base);
    expect(scoreWithModel({ ...good, seller: { ...good.seller, bureauScore: 850 } }).pd).toBeLessThan(base);
  });

  it("gives readable reasons: at most four, largest first, each saying which way it pushes", () => {
    const r = scoreWithModel(weak).reasons;
    expect(r.length).toBeGreaterThan(0); expect(r.length).toBeLessThanOrEqual(4);
    expect(r.every((x) => /^(Raises|Lowers) risk: /.test(x.text))).toBe(true);
    const mags = r.map((x) => Math.abs(x.impact));
    expect([...mags].sort((a, b) => b - a)).toEqual(mags);
    expect(r[0].text).toMatch(/Raises risk/);
  });

  it("copes with missing bureau data and extreme values", () => {
    const x = features({ ...good, seller: { ...good.seller, bureauScore: null } });
    expect(x.noBureau).toBe(1); expect(x.sellerBureau).toBe(650);
    expect(scoreWithModel({ ...weak, invoiceAmount: 1n, seller: { ...weak.seller, limit: 0n } }).pd).toBeLessThanOrEqual(1);
  });

  it("maps probabilities to grades at the documented cut-offs", () => {
    expect([0.005, 0.015, 0.03, 0.07, 0.2].map(gradeOfPd)).toEqual(["A", "B", "C", "D", "E"]);
    expect(gradeGap("A", "C")).toBe(2); expect(gradeGap("C", "A")).toBe(-2);
  });
});

describe("assist mode only ever tightens", () => {
  const worseModel = { ...scoreWithModel(weak) }; // grade D or E
  it("does nothing unless mode is assist, the rules approved, and the gap is two grades or more", () => {
    ML.mode = 1; expect(assist("approved", "A", worseModel)).toBeNull();
    ML.mode = 0; expect(assist("approved", "A", worseModel)).toBeNull();
    ML.mode = 2;
    expect(assist("approved", "A", worseModel)?.code).toBe("ML_REVIEW");
    expect(assist("approved", "A", { ...worseModel, grade: "B" })).toBeNull(); // a one-grade gap is normal disagreement
    expect(assist("declined", "E", worseModel)).toBeNull(); // never touches a decline
    expect(assist("referred", "C", worseModel)).toBeNull(); // already going to a person
    expect(assist("approved", "E", { ...worseModel, grade: "A" })).toBeNull(); // never loosens
  });
  it("agrees with the rules' own verdict on the good case", () => { expect(decide(good).decision).toBe("approved"); });
});

describe("recorded beside every decision", () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => { w = await world(); });
  const eligible = async (n: number) => {
    const { id } = await createInvoice(w.db, { sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: `M-${n}`, invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 5_00_000_00n, contentHash: `m${n}`, irn: `IRN-OK-${n}` }, mock, T0);
    await w.db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id));
    return id;
  };

  it("shadow mode stores the model's view and leaves the decision exactly as the rules made it", async () => {
    ML.mode = 1;
    const id = await eligible(1);
    const d = await underwriteInvoice(w.db, id, gw, T0);
    const [m] = await w.db.select().from(mlScores).where(eq(mlScores.invoiceId, id));
    expect(m).toMatchObject({ version: "prior-1", rulesGrade: d.riskGrade, rulesDecision: d.decision, finalDecision: d.decision });
    expect(Number(m.pd)).toBeGreaterThan(0);
    expect((await w.db.select().from(underwritingDecisions).where(eq(underwritingDecisions.invoiceId, id)))[0].decision).toBe("approved");
  });

  it("mode off stores nothing", async () => {
    ML.mode = 0;
    const id = await eligible(2);
    await underwriteInvoice(w.db, id, gw, T0);
    expect(await w.db.select().from(mlScores)).toHaveLength(0);
  });

  it("the monitor reports agreement and outcomes by grade", async () => {
    ML.mode = 1;
    for (const n of [3, 4]) await underwriteInvoice(w.db, await eligible(n), gw, T0);
    const r = await modelReport(w.db);
    expect(r.total).toBe(2);
    expect(Object.values(r.matrix).flatMap((row) => Object.values(row)).reduce((a, b) => a + b, 0)).toBe(2);
    expect(r.rulesOutcomes.reduce((a, g) => a + g.invoices, 0)).toBe(2);
    expect(r.modelOutcomes.reduce((a, g) => a + g.open, 0)).toBe(2); // nothing has settled yet
    expect(r.agreementPct).toBeGreaterThanOrEqual(0);
  });
});
