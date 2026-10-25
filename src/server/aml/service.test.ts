import { describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { sanctionsEntries, sanctionsLoads } from "../db/schema";
import { ALT_CSV, EU_XML, SDN_CSV, UN_XML } from "./fixtures";
import { EU_URL, OFAC_ALT_URL, OFAC_SDN_URL, UN_URL } from "./lists";
import { localAml, refreshSanctionLists, sanctionsStatus, screenDetailed } from "./service";

const T0 = new Date("2026-10-06T00:00:00Z");
const DAY = 86_400_000;

type Files = Record<string, string | number>; // url -> body, or an HTTP status for a failure
const stub = (files: Files) => async (url: string) => {
  const v = files[url];
  if (v === undefined) throw new Error(`no stub for ${url}`);
  return typeof v === "number" ? { ok: false, status: v, text: async () => "" } : { ok: true, status: 200, text: async () => v };
};
const GOOD: Files = { [OFAC_SDN_URL]: SDN_CSV, [OFAC_ALT_URL]: ALT_CSV, [UN_URL]: UN_XML, [EU_URL]: EU_XML };
const rowsOf = async (db: Awaited<ReturnType<typeof testDb>>, list: string) => (await db.select({ n: count() }).from(sanctionsEntries).where(eq(sanctionsEntries.list, list)))[0].n;

describe("refreshSanctionLists", () => {
  it("loads every list and records each load", async () => {
    const db = await testDb();
    const r = await refreshSanctionLists(db, { fetch: stub(GOOD), now: T0 });
    expect(r).toEqual([{ list: "ofac_sdn", ok: true, entries: 11 }, { list: "un", ok: true, entries: 7 }, { list: "eu", ok: true, entries: 4 }]);
    expect(await rowsOf(db, "ofac_sdn")).toBe(11);
    const loads = await db.select().from(sanctionsLoads);
    expect(loads).toHaveLength(3);
    expect(loads.find((l) => l.list === "ofac_sdn")).toMatchObject({ entries: 11, sourceUrl: `${OFAC_SDN_URL} + ${OFAC_ALT_URL}` });
    expect(loads[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db.select().from(sanctionsEntries).where(eq(sanctionsEntries.externalId, "90003"));
    expect(row.norm).toBeTruthy();
  });

  it("replaces a list's rows on reload instead of piling up", async () => {
    const db = await testDb();
    await refreshSanctionLists(db, { fetch: stub(GOOD), now: T0 });
    await refreshSanctionLists(db, { fetch: stub(GOOD), now: new Date(T0.getTime() + DAY) });
    expect(await rowsOf(db, "ofac_sdn")).toBe(11);
    // A smaller (but not collapsed) UN list replaces the old one.
    const smaller = UN_XML.replace(/<INDIVIDUAL>[\s\S]*?<\/INDIVIDUAL>\s*<INDIVIDUAL>/, "<INDIVIDUAL>");
    await refreshSanctionLists(db, { fetch: stub({ ...GOOD, [UN_URL]: smaller }), now: new Date(T0.getTime() + 2 * DAY) });
    expect(await rowsOf(db, "un")).toBe(5);
    expect(await db.select().from(sanctionsLoads)).toHaveLength(9);
  });

  it("a failing list keeps its old rows and does not stop the others", async () => {
    const db = await testDb();
    await refreshSanctionLists(db, { fetch: stub(GOOD), now: T0 });
    const later = new Date(T0.getTime() + DAY);
    const smallerSdn = SDN_CSV.split("\r\n").slice(0, 2).join("\r\n");
    const r = await refreshSanctionLists(db, { fetch: stub({ ...GOOD, [EU_URL]: 503, [UN_URL]: "<broken", [OFAC_SDN_URL]: smallerSdn }), now: later });
    expect(r.map((x) => [x.list, x.ok])).toEqual([["ofac_sdn", false], ["un", false], ["eu", false]]);
    expect(r[1].error).toMatch(/no entries/);
    expect(r[2].error).toMatch(/503/);
    expect(r[0].error).toMatch(/keeping the old list/); // collapsed to under half: refused
    expect(await rowsOf(db, "eu")).toBe(4);
    expect(await rowsOf(db, "un")).toBe(7);
    expect(await rowsOf(db, "ofac_sdn")).toBe(11);
    // One list down, the others still refresh.
    const r2 = await refreshSanctionLists(db, { fetch: stub({ ...GOOD, [EU_URL]: 500 }), now: later });
    expect(r2.map((x) => x.ok)).toEqual([true, true, false]);
    expect((await db.select().from(sanctionsLoads).where(eq(sanctionsLoads.list, "un"))).length).toBe(2);
  });

  it("inserts a large list in batches", async () => {
    const db = await testDb();
    const rows = Array.from({ length: 5200 }, (_, i) => `${100000 + i},"PARTY NUMBER ${i} TRADING",-0- ,"TEST",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `).join("\r\n");
    const r = await refreshSanctionLists(db, { fetch: stub({ ...GOOD, [OFAC_SDN_URL]: rows, [OFAC_ALT_URL]: "" }), now: T0 });
    expect(r[0]).toEqual({ list: "ofac_sdn", ok: true, entries: 5200 });
    expect(await rowsOf(db, "ofac_sdn")).toBe(5200);
  });
});

describe("localAml", () => {
  const loaded = async () => { const db = await testDb(); await refreshSanctionLists(db, { fetch: stub(GOOD), now: T0 }); return db; };

  it("fails closed when nothing was ever loaded", async () => {
    const db = await testDb();
    await expect(localAml(db, { now: () => T0 }).screenAml("Anyone")).rejects.toThrow(/never been loaded/);
  });

  it("fails closed when the lists are empty even if a load was recorded", async () => {
    const db = await loaded();
    await db.delete(sanctionsEntries);
    await expect(localAml(db, { now: () => T0 }).screenAml("Anyone")).rejects.toThrow(/never been loaded/);
  });

  it("returns a hit and a clean result", async () => {
    const db = await loaded();
    const aml = localAml(db, { now: () => new Date(T0.getTime() + DAY) });
    expect(await aml.screenAml("Osama bin Laden")).toEqual({ score: 100, hit: true });
    expect(await aml.screenAml("Melli Bank Iran")).toMatchObject({ hit: true });
    const clean = await aml.screenAml("Bharat Retail Pvt Ltd");
    expect(clean.hit).toBe(false);
    expect(clean.score).toBeLessThan(88);
    expect(await aml.screenAml("")).toEqual({ score: 0, hit: false });
  });

  it("fails closed once any list is older than maxAgeDays, and recovers after a refresh", async () => {
    const db = await loaded();
    let t = new Date(T0.getTime() + 6 * DAY);
    const aml = localAml(db, { maxAgeDays: 7, now: () => t });
    await expect(aml.screenAml("Bharat Retail")).resolves.toMatchObject({ hit: false });
    t = new Date(T0.getTime() + 8 * DAY); // the cached index must not outlive the limit
    await expect(aml.screenAml("Bharat Retail")).rejects.toThrow(/older than 7 days/);
    // Only the EU list refreshed: the other two are still stale, so still closed.
    await refreshSanctionLists(db, { fetch: stub({ ...GOOD, [UN_URL]: 500, [OFAC_SDN_URL]: 500 }), now: t });
    t = new Date(t.getTime() + 11 * 60_000); // past the cache life, so it reloads
    await expect(aml.screenAml("Bharat Retail")).rejects.toThrow(/older than 7 days/);
    await refreshSanctionLists(db, { fetch: stub(GOOD), now: t });
    t = new Date(t.getTime() + 11 * 60_000);
    await expect(aml.screenAml("Bharat Retail")).resolves.toMatchObject({ hit: false });
  });
});

describe("sanctionsStatus and screenDetailed", () => {
  it("reports each list, including one that never loaded", async () => {
    const db = await testDb();
    await refreshSanctionLists(db, { fetch: stub({ ...GOOD, [EU_URL]: 500 }), now: T0 });
    const s = await sanctionsStatus(db, { now: new Date(T0.getTime() + 8 * DAY) });
    expect(s).toEqual([
      { list: "ofac_sdn", loadedAt: T0, entries: 11, stale: true },
      { list: "un", loadedAt: T0, entries: 7, stale: true },
      { list: "eu", loadedAt: null, entries: 0, stale: true },
    ]);
    expect((await sanctionsStatus(db, { now: T0 })).map((x) => x.stale)).toEqual([false, false, true]);
  });

  it("gives a reviewer the matches", async () => {
    const db = await testDb();
    await refreshSanctionLists(db, { fetch: stub(GOOD), now: T0 });
    const m = await screenDetailed(db, "Saddam Hussein Al Tikriti", { now: () => T0 });
    expect(m.map((x) => x.list).sort()).toEqual(["eu", "un"]);
    expect(m[0]).toMatchObject({ kind: "individual", country: expect.any(String) });
  });
});
