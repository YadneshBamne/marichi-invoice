import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appSettings, auditLog, settingsHistory } from "../db/schema";
import { testDb } from "../testdb";
import { priceOffer } from "../offers/pricing";
import { POLICY } from "../underwriting/policy";
import { COLLECTIONS } from "../collections/waterfall";
import { DEFS, display, listSettings, parseInput, DEF_BY_KEY, refreshPolicy, resetPolicyForTests, resetSetting, updateSettings } from "./policy";

const admin = { id: "00000000-0000-0000-0000-0000000000a1", role: "admin" };
let db: Awaited<ReturnType<typeof testDb>>;
beforeEach(async () => { resetPolicyForTests(); db = await testDb(); });
afterEach(() => resetPolicyForTests());

describe("editable policy values", () => {
  it("every setting round-trips through its input form", () => {
    for (const d of DEFS) expect(parseInput(d, (d.kind === "percent" ? String(Number(d.fallback) / 100) : d.kind === "rupees" ? String(Number(d.fallback) / 100) : String(d.fallback)))).toBe(d.fallback);
  });

  it("a change applies live to the modules that read it, with history and an audit entry", async () => {
    expect(priceOffer({ amount: 100_000_00n, advanceBps: 8500, discountBps: 1500, tenorDays: 30 }).feeAmount).toBe(500_00n); // 0.5%
    const r = await updateSettings(db, admin, { "offer.processingFeeBps": "1", "collections.graceDays": "7", "uw.minBureauScore": "600" }, "Board approved new pricing");
    expect(r.changed).toBe(3);
    expect(priceOffer({ amount: 100_000_00n, advanceBps: 8500, discountBps: 1500, tenorDays: 30 }).feeAmount).toBe(1_000_00n); // 1%
    expect(COLLECTIONS.graceDays).toBe(7); expect(POLICY.minBureauScore).toBe(600);
    const h = await db.select().from(settingsHistory).where(eq(settingsHistory.key, "offer.processingFeeBps"));
    expect(h).toEqual([expect.objectContaining({ version: 1, before: 50, after: 100, note: "Board approved new pricing" })]);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "policy.changed"))).toHaveLength(3);
  });

  it("money values are entered in rupees and stored as paise", async () => {
    await updateSettings(db, admin, { "disburse.approvalThreshold": "15,00,000", "uw.matrix.A.autoMax": "30,00,000" }, "Raise limits for trusted grades");
    expect(DEF_BY_KEY.get("disburse.approvalThreshold")!.get()).toBe(15_00_000_00n);
    expect(POLICY.matrix.A.autoMax).toBe(30_00_000_00n);
    expect(display(DEF_BY_KEY.get("disburse.approvalThreshold")!, 15_00_000_00n)).toBe("₹15,00,000.00");
  });

  it("rejects bad values, bad combinations, missing reasons and non-admins, and changes nothing", async () => {
    await expect(updateSettings(db, admin, { "collections.graceDays": "99" }, "too long a grace")).rejects.toThrow(/between/);
    await expect(updateSettings(db, admin, { "collections.graceDays": "abc" }, "not a number")).rejects.toThrow(/number/);
    await expect(updateSettings(db, admin, { "uw.minTenorDays": "100", "uw.maxTenorDays": "50" }, "tenor flipped")).rejects.toThrow(/Shortest/);
    await expect(updateSettings(db, admin, { "collections.graceDays": "6" }, "no")).rejects.toThrow(/reason/);
    await expect(updateSettings(db, { id: admin.id, role: "ops" }, { "collections.graceDays": "6" }, "ops cannot do this")).rejects.toThrow(/administrator/);
    await expect(updateSettings(db, admin, { "made.up": "1" }, "unknown key given")).rejects.toThrow(/unknown/);
    expect(COLLECTIONS.graceDays).toBe(5); expect(await db.select().from(appSettings)).toHaveLength(0);
  });

  it("a second change bumps the version; reset restores the default and is recorded", async () => {
    await updateSettings(db, admin, { "collections.graceDays": "6" }, "first change here");
    await updateSettings(db, admin, { "collections.graceDays": "4" }, "second change here");
    expect((await db.select().from(appSettings))[0].version).toBe(2);
    await resetSetting(db, admin, "collections.graceDays", "back to the default");
    expect(COLLECTIONS.graceDays).toBe(5);
    expect(await db.select().from(appSettings)).toHaveLength(0);
    const hist = await db.select().from(settingsHistory).where(eq(settingsHistory.key, "collections.graceDays"));
    expect(hist.map((x) => x.after)).toEqual(expect.arrayContaining([6, 4, null]));
    const s = (await listSettings(db)).find((x) => x.def.key === "collections.graceDays")!;
    expect(s).toMatchObject({ overridden: false, current: 5, history: 3 });
  });

  it("another server instance picks the change up from the database, and drops it again on reset", async () => {
    await updateSettings(db, admin, { "collections.penalBps": "18" }, "tighten the penal rate");
    resetPolicyForTests(); // simulate a fresh process that has not seen the change
    expect(COLLECTIONS.penalBps).toBe(1200);
    await refreshPolicy(db);
    expect(COLLECTIONS.penalBps).toBe(1800);
    await db.delete(appSettings);
    await refreshPolicy(db, true);
    expect(COLLECTIONS.penalBps).toBe(1200);
  });
});
