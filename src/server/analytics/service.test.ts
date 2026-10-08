import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notifications, reportRuns } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { recordIncomingPayment, writeOff } from "../collections/service";
import { concentration, forecast, forecastCsv, runDueReports, subscribe, unsubscribe, vintages } from "./service";

let w: Awaited<ReturnType<typeof world>>;
const L = 1_00_000_00n;
const at = (d: string) => new Date(`${d}T10:00:00Z`);
beforeEach(async () => { w = await world(); });
const seller = () => ({ role: "seller", businessId: w.sellerId });
const pay = (account: string, amount: bigint, day: string, utr: string) => recordIncomingPayment(w.db, { accountNumber: account, amount, utr, receivedAt: at(day) }, gw, at(day));

describe("vintages", () => {
  it("groups by the month money went out and follows repayment, lateness and loss", async () => {
    const a = await w.financed(), b = await w.financed(), c = await w.financed();
    await pay(a.account, 10n * L, "2026-11-20", "V1"); // a: repaid in full
    // b: untouched and far past due; c: written off
    await writeOff(w.db, c.invoiceId, { id: "00000000-0000-0000-0000-0000000000a2", role: "admin" }, "gone", at("2027-03-01"));
    const [m] = await vintages(w.db, { role: "ops", businessId: null }, at("2027-03-01"));
    expect(m).toMatchObject({ month: "2026-10", invoices: 3, advanced: 27n * L, repaid: 9n * L, lost: 9n * L });
    expect(m.outstanding).toBe(9n * L); // only b is still open
    expect(m.late30).toBe(9n * L);
    expect(m.repaidPct).toBe(33.33);
    expect(m.lossPct).toBe(33.33);
    expect(m.earned).toBeGreaterThan(0n);
    void b;
  });
  it("shows a company only its own funded invoices", async () => {
    await w.financed();
    expect(await vintages(w.db, { role: "seller", businessId: w.buyerId })).toEqual([]);
    expect(await vintages(w.db, seller())).toHaveLength(1);
  });
});

describe("concentration", () => {
  it("measures how much of the open book sits with each buyer and seller", async () => {
    await w.financed(); await w.financed(5n * L);
    const c = await concentration(w.db, { role: "ops", businessId: null });
    expect(c.total).toBe(9n * L + 4_50_000_00n);
    expect(c.byBuyer).toMatchObject({ count: 1, hhi: 10_000 });
    expect(c.byBuyer.top[0]).toMatchObject({ name: "Big Corp", share: 100 });
  });
});

describe("forecast", () => {
  async function book() {
    const f = await w.financed(); // due 2026-11-20, advance ₹9L
    const open = await w.offered(); // eligible, not financed, ₹10L
    return { f, open };
  }
  it("seller: what buyers will pay, net of advances, in the week it is due", async () => {
    await book();
    const fc = await forecast(w.db, seller(), T0);
    const week = fc.weeks[6]; // 45 days out
    expect(week.values["Buyer pays you"]).toBe(10n * L);
    expect(week.values["Buyer pays, net of your advance"]).toBeGreaterThan(0n);
    expect(week.values["Buyer pays, net of your advance"]).toBeLessThan(L); // ₹10L less ₹9L less the discount
    expect(Object.values(fc.overdue).every((v) => v === 0n)).toBe(true);
    expect(forecastCsv(fc).split(/\r?\n/)[0]).toBe("week_starting,buyer_pays_you,buyer_pays_net_of_your_advance");
  });
  it("buyer: what is owed; staff: collections on the funded book only; money past due is shown apart", async () => {
    await book();
    expect((await forecast(w.db, { role: "buyer", businessId: w.buyerId }, T0)).weeks[6].values["You owe"]).toBe(20n * L);
    const staff = await forecast(w.db, { role: "ops", businessId: null }, T0);
    expect(staff.weeks[6].values["Principal"]).toBe(9n * L);
    const late = await forecast(w.db, { role: "buyer", businessId: w.buyerId }, at("2026-12-01"));
    expect(late.overdue["You owe"]).toBe(20n * L);
    expect(late.weeks.every((x) => x.values["You owe"] === 0n)).toBe(true);
  });
  it("is scoped: another seller sees nothing", async () => {
    await book();
    const fc = await forecast(w.db, { role: "seller", businessId: w.buyerId }, T0);
    expect(fc.weeks.every((x) => Object.values(x.values).every((v) => v === 0n))).toBe(true);
  });
});

describe("scheduled reports", () => {
  it("builds a report when due, not again within the period, and again after it; unsubscribing stops it", async () => {
    await w.financed();
    await expect(subscribe(w.db, { ...w.sellerActor }, "nonsense", "weekly")).rejects.toThrow("unknown report");
    await expect(subscribe(w.db, { ...w.sellerActor }, "forecast", "daily")).rejects.toThrow("weekly or monthly");
    await subscribe(w.db, w.sellerActor, "forecast", "weekly");
    await subscribe(w.db, w.sellerActor, "forecast", "weekly"); // idempotent
    expect(await runDueReports(w.db, gw, T0)).toBe(1);
    const [run] = await w.db.select().from(reportRuns);
    expect(run.filename).toBe("forecast-2026-10-06.csv");
    expect(run.content).toContain("week_starting");
    expect((await w.db.select().from(notifications).where(eq(notifications.template, "report_ready"))).length).toBeGreaterThan(0);
    expect(await runDueReports(w.db, gw, new Date(T0.getTime() + 3 * 86_400_000))).toBe(0);
    expect(await runDueReports(w.db, gw, new Date(T0.getTime() + 7 * 86_400_000))).toBe(1);
    await unsubscribe(w.db, w.sellerActor.id, "forecast");
    expect(await runDueReports(w.db, gw, new Date(T0.getTime() + 30 * 86_400_000))).toBe(0);
    expect(await w.db.select().from(reportRuns)).toHaveLength(2);
  });
});
