import { beforeEach, describe, expect, it } from "vitest";
import { world } from "../testkit";
import { navBadges } from "./badges";
import { sellerDashboard } from "./dashboards";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });

describe("sidebar badges and onboarding checklist", () => {
  it("runs for every role and shows only non-zero counts", async () => {
    expect(await navBadges(w.db, { role: "seller", businessId: w.sellerId })).toEqual({});
    expect(await navBadges(w.db, { role: "buyer", businessId: w.buyerId })).toEqual({});
    expect(await navBadges(w.db, { role: "admin", businessId: null })).toEqual({});
    expect(await navBadges(w.db, { role: "financier", businessId: null })).toEqual({});
  });
  it("seller checklist flips as steps are completed", async () => {
    expect((await sellerDashboard(w.db, w.sellerId)).setup).toEqual({ verified: true, buyer: true, invoice: false, funded: false });
    await w.financed();
    expect((await sellerDashboard(w.db, w.sellerId)).setup).toEqual({ verified: true, buyer: true, invoice: true, funded: true });
  });
});
