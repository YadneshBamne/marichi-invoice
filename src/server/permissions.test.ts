import { describe, expect, it } from "vitest";
import { assertCan, can, INVITABLE, POWERFUL, roleOf } from "./permissions";

const R = (orgRole: string) => ({ orgRole });

describe("company permissions", () => {
  it("makers prepare, approvers commit, admins run the team, owners do everything", () => {
    expect(can(R("maker"), "invoice.upload")).toBe(true);
    expect(can(R("maker"), "offer.prepare")).toBe(true);
    expect(can(R("maker"), "offer.answer")).toBe(false);
    expect(can(R("approver"), "offer.answer")).toBe(true);
    expect(can(R("approver"), "agreement.sign")).toBe(true);
    expect(can(R("approver"), "team.manage")).toBe(false);
    expect(can(R("owner"), "team.manage")).toBe(true);
    expect(can(R("owner"), "offer.answer")).toBe(true);
  });
  it("managing people is separate from moving money: an admin can run the team but cannot commit money", () => {
    expect(can(R("admin"), "team.manage")).toBe(true);
    expect(can(R("admin"), "company.edit")).toBe(true);
    for (const p of ["offer.answer", "agreement.sign", "bid.place", "earlypay.propose", "creditnote.issue", "approval.decide", "invoice.upload"] as const) expect(can(R("admin"), p), p).toBe(false);
  });
  it("only the owner hands out approver or admin access and changes approval settings", () => {
    expect(can(R("owner"), "team.grant")).toBe(true);
    for (const r of ["admin", "approver", "maker", "viewer"]) { expect(can(R(r), "team.grant")).toBe(false); expect(can(R(r), "approval.settings")).toBe(false); }
    expect(POWERFUL).toEqual(["admin", "approver"]);
    expect(INVITABLE).not.toContain("owner");
  });
  it("a viewer can only look", () => {
    expect(can(R("viewer"), "invoice.view")).toBe(true);
    for (const p of ["invoice.upload", "offer.prepare", "offer.answer", "team.manage", "ticket.open", "bid.prepare"] as const) expect(can(R("viewer"), p), p).toBe(false);
  });
  it("only approvers and the owner decide a request", () => {
    expect(can(R("approver"), "approval.decide")).toBe(true);
    expect(can(R("owner"), "approval.decide")).toBe(true);
    expect(can(R("maker"), "approval.decide")).toBe(false);
  });
  it("accounts without a role are treated as the founding owner", () => {
    expect(roleOf({ orgRole: null })).toBe("owner");
    expect(can({}, "apps.manage")).toBe(true);
  });
  it("assertCan throws a readable error", () => {
    expect(() => assertCan(R("maker"), "agreement.sign")).toThrow(/not allowed/);
  });
});
