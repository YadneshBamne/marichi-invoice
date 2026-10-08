import { describe, expect, it } from "vitest";
import { cleanSelection, enabledApps } from "../../lib/apps";
import { navFor } from "./nav";

const hrefs = (role: string, o?: Parameters<typeof navFor>[1]) => navFor(role, o).flatMap((s) => s.items.map((i) => i.href));

describe("company apps drive the sidebar", () => {
  it("core apps are always on; optional ones only when picked", () => {
    expect([...enabledApps("seller", [])]).toEqual(["invoicing"]);
    expect([...enabledApps("seller", ["support", "confirmations", "nonsense"])].sort()).toEqual(["invoicing", "support"]);
    expect([...enabledApps("buyer", ["exports"])].sort()).toEqual(["confirmations", "exports"]);
  });
  it("selections are cleaned to ids that exist for the company type", () => {
    expect(cleanSelection("seller", ["support", "confirmations", "marketplace", "support", "x"])).toEqual(["support", "marketplace"]);
  });
  it("owner sees Apps and Team; a member does not; a removed app disappears", () => {
    const owner = hrefs("seller", { apps: ["invoicing", "support"], orgRole: "owner" });
    expect(owner).toEqual(expect.arrayContaining(["/dashboard", "/seller/invoices", "/seller/buyers", "/seller/agreements", "/support", "/apps", "/settings/team", "/settings"]));
    const member = hrefs("seller", { apps: ["invoicing"], orgRole: "member" });
    expect(member).not.toContain("/apps"); expect(member).not.toContain("/settings/team"); expect(member).not.toContain("/support");
  });
  it("followed roadmap modules show as coming soon, only for roles they apply to", () => {
    const s = navFor("seller", { apps: ["invoicing"], picked: ["marketplace", "supply-chain-finance"], orgRole: "owner" });
    const soon = s.find((x) => x.label === "Coming soon")!.items.map((i) => i.href);
    expect(soon).toEqual(["/soon/marketplace"]); // supply-chain-finance is a buyer module
    expect(navFor("seller", { apps: ["invoicing"], orgRole: "owner" }).some((x) => x.label === "Coming soon")).toBe(false);
  });
  it("staff get their fixed console regardless of apps", () => {
    expect(hrefs("ops")).toContain("/admin/kyb");
    expect(hrefs("admin")).toContain("/admin/users");
    expect(hrefs("ops")).not.toContain("/admin/users");
  });
});
