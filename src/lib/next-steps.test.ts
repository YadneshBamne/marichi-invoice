import { describe, expect, it } from "vitest";
import { buyerSteps, financierSteps, progress, sellerSteps } from "./next-steps";

describe("the next-steps list", () => {
  it("a new seller starts at verification; the first open step is the one to act on", () => {
    const s = sellerSteps({ kyb: "draft", buyer: false, invoice: false, funded: false });
    expect(s.map((x) => x.id)).toEqual(["verify", "buyer", "invoice", "paid"]);
    expect(progress(s)).toEqual({ done: 0, total: 4, next: 0, complete: false });
    expect(s[0].waiting).toBeUndefined();
  });

  it("while staff review a company, its verification step waits instead of asking again", () => {
    for (const kyb of ["submitted", "under_review"]) {
      const s = sellerSteps({ kyb, buyer: false, invoice: false, funded: false });
      expect(s[0]).toMatchObject({ done: false, waiting: expect.stringMatching(/reviewing/) });
    }
    expect(sellerSteps({ kyb: "info_requested", buyer: false, invoice: false, funded: false })[0].waiting).toBeUndefined();
  });

  it("steps are done in order and the list is complete only when all are", () => {
    const s = sellerSteps({ kyb: "approved", buyer: true, invoice: false, funded: false });
    expect(progress(s)).toMatchObject({ done: 2, next: 2, complete: false });
    expect(progress(sellerSteps({ kyb: "approved", buyer: true, invoice: true, funded: true }))).toMatchObject({ done: 4, next: -1, complete: true });
  });

  it("a buyer's verification is optional wording, and auto-pay comes last", () => {
    const s = buyerSteps({ kyb: "draft", confirmed: false, autopay: false });
    expect(s.map((x) => x.id)).toEqual(["verify", "confirm", "autopay"]);
    expect(s[0].detail).toMatch(/Optional/);
    expect(progress(buyerSteps({ kyb: "approved", confirmed: true, autopay: true })).complete).toBe(true);
  });

  it("a financier cannot bid before the application is approved: the licence check shows as waiting while submitted", () => {
    const s = financierSteps({ kyb: "approved", application: "submitted", limits: false, funded: false, deployed: false });
    expect(s.map((x) => x.id)).toEqual(["verify", "apply", "limits", "fund", "bid"]);
    expect(s[1]).toMatchObject({ done: false, waiting: expect.stringMatching(/licence/) });
    expect(progress(s)).toMatchObject({ done: 1, next: 1 });
    expect(financierSteps({ kyb: "approved", application: "approved", limits: true, funded: true, deployed: true }).every((x) => x.done)).toBe(true);
    expect(financierSteps({ kyb: "approved", application: "approved", limits: true, funded: false, deployed: true })[3].done).toBe(true); // money already out means it was funded
  });
});
