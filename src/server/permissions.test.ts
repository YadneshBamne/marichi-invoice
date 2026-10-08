import { describe, expect, it } from "vitest";
import { assertCan, can, roleOf } from "./permissions";

describe("company permissions", () => {
  it("members prepare, managers commit, owners administer", () => {
    expect(can({ orgRole: "member" }, "invoice.upload")).toBe(true);
    expect(can({ orgRole: "member" }, "offer.answer")).toBe(false);
    expect(can({ orgRole: "manager" }, "offer.answer")).toBe(true);
    expect(can({ orgRole: "manager" }, "agreement.sign")).toBe(true);
    expect(can({ orgRole: "manager" }, "team.manage")).toBe(false);
    expect(can({ orgRole: "owner" }, "team.manage")).toBe(true);
  });
  it("accounts without a role are treated as the founding owner", () => {
    expect(roleOf({ orgRole: null })).toBe("owner");
    expect(can({}, "apps.manage")).toBe(true);
  });
  it("assertCan throws a readable error", () => {
    expect(() => assertCan({ orgRole: "member" }, "agreement.sign")).toThrow(/not allowed/);
  });
});
