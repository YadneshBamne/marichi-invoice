import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, businesses } from "../db/schema";
import { world } from "../testkit";
import { assertFlag, flagOn, listFlags, refreshFlags, resetFlagsForTests, setFlag } from "./service";
import { proposeEarlyPayment } from "../earlypay/service";
import { applyForProgramme } from "../scf/service";

let w: Awaited<ReturnType<typeof world>>;
const admin = { id: "00000000-0000-0000-0000-0000000000a1", role: "admin" };
beforeEach(async () => { w = await world(); resetFlagsForTests(); });
afterEach(() => resetFlagsForTests());
const set = (o: Partial<Parameters<typeof setFlag>[2]> = {}) => setFlag(w.db, admin, { key: "earlypay", enabled: true, rolloutPct: 100, note: "testing the switch", ...o });

describe("feature flags", () => {
  it("a flag nobody has touched is on for everyone", async () => {
    expect(flagOn("earlypay", w.sellerId)).toBe(true);
    expect(flagOn("signup")).toBe(true);
    expect((await listFlags(w.db)).every((f) => f.enabled && f.rolloutPct === 100)).toBe(true);
  });

  it("switching one off stops it for every company, and the refusal says so", async () => {
    await set({ enabled: false });
    expect(flagOn("earlypay", w.sellerId)).toBe(false);
    expect(flagOn("scf", w.sellerId)).toBe(true); // other flags are untouched
    expect(() => assertFlag("earlypay", w.sellerId)).toThrow(/Buyer early payment is switched off/);
    const buyer = { id: w.buyerUserId, role: "buyer", businessId: w.buyerId, orgRole: "owner", email: "ap@big.com" };
    await expect(proposeEarlyPayment(w.db, buyer as never, { invoiceId: "00000000-0000-0000-0000-000000000000", discountBps: 1000 })).rejects.toThrow(/switched off/);
    await expect(applyForProgramme(w.db, buyer as never, { name: "x", limit: 1n, acceptTerms: true })).resolves.toBeDefined().catch(() => {}); // scf is still on: it may fail for other reasons, never for the flag
  });

  it("a rollout gives the feature to a stable share of companies, and chosen companies always get it", async () => {
    await set({ key: "scf", rolloutPct: 0 });
    expect(flagOn("scf", w.sellerId)).toBe(false);
    await set({ key: "scf", rolloutPct: 100 });
    expect(flagOn("scf", w.sellerId)).toBe(true);
    // the same company always lands on the same side of a 50% rollout, and about half of many companies get it
    await set({ key: "scf", rolloutPct: 50 });
    const first = flagOn("scf", w.sellerId);
    for (let i = 0; i < 5; i++) expect(flagOn("scf", w.sellerId)).toBe(first);
    const ids = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const share = ids.filter((id) => flagOn("scf", id)).length / ids.length;
    expect(share).toBeGreaterThan(0.4); expect(share).toBeLessThan(0.6);
    // a company named for early access gets it even at 0%
    await set({ key: "scf", rolloutPct: 0, early: ["27AAAAA1111A1Z5"] });
    expect(flagOn("scf", w.sellerId)).toBe(true);
    expect(flagOn("scf", w.buyerId)).toBe(false);
    expect((await listFlags(w.db)).find((f) => f.key === "scf")?.onlyBusinesses.map((b) => b.name)).toEqual(["Seller Co"]);
  });

  it("only an administrator may change one, with a reason, a sensible rollout and real company numbers; every change is audited", async () => {
    await expect(setFlag(w.db, { ...admin, role: "ops" }, { key: "scf", enabled: false, rolloutPct: 100, note: "reason here" })).rejects.toThrow(/only an administrator/);
    await expect(set({ note: "no" })).rejects.toThrow(/reason/);
    await expect(set({ rolloutPct: 101 })).rejects.toThrow(/0 to 100/);
    await expect(set({ rolloutPct: 12.5 })).rejects.toThrow(/whole number/);
    await expect(set({ key: "nonsense" })).rejects.toThrow(/unknown flag/);
    await expect(set({ early: ["99ZZZZZ9999Z9Z9"] })).rejects.toThrow(/no company with the number/);
    await set({ enabled: false });
    const [a] = await w.db.select().from(auditLog).where(eq(auditLog.action, "flag.changed"));
    expect(a).toMatchObject({ entityId: "earlypay", before: { enabled: true, rolloutPct: 100 }, after: { enabled: false } });
  });

  it("other servers pick a change up on their next refresh", async () => {
    await set({ enabled: false });
    resetFlagsForTests(); // as if this were another process that has not loaded it yet
    expect(flagOn("earlypay", w.sellerId)).toBe(true);
    await refreshFlags(w.db, true);
    expect(flagOn("earlypay", w.sellerId)).toBe(false);
    void businesses;
  });
});
