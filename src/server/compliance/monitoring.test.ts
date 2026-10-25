import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, businesses, financierProfiles, financingOffers, fraudCases, invoices, notifications, ubos } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { assertNotFrozen, KYB_AML_RULE } from "../fraud/service";
import { submitKyb } from "../kyb/service";
import { MONITOR, recheckIrns, remindLicences, requestRekyc, rescreenParties, runRekyc } from "./monitoring";
import type { Adapters } from "../integrations/gateway";

let w: Awaited<ReturnType<typeof world>>;
beforeEach(async () => { w = await world(); });
const day = (n: number, from = T0) => new Date(from.getTime() + n * 86_400_000);
const sent = async (template: string) => (await w.db.select().from(notifications)).filter((n) => n.template === template);
const biz = async (id: string) => (await w.db.select().from(businesses).where(eq(businesses.id, id)))[0];

describe("ongoing sanctions re-screening", () => {
  it("checks each approved company and its owners again, then leaves it alone until the check goes stale", async () => {
    expect(await rescreenParties(w.db, gw, T0)).toEqual({ screened: 2, hits: 0, failed: 0 }); // seller and buyer
    expect((await biz(w.sellerId)).amlScreenedAt).toEqual(T0);
    expect((await w.db.select().from(ubos).where(eq(ubos.businessId, w.sellerId)))[0]).toMatchObject({ screeningHit: false });
    expect(await rescreenParties(w.db, gw, day(3))).toMatchObject({ screened: 0 });
    expect(await rescreenParties(w.db, gw, day(MONITOR.rescreenDays + 1))).toMatchObject({ screened: 2 });
  });

  it("a new hit drops the company to review with a compliance case, tells it only that it is under review, and compliance must clear it", async () => {
    await w.db.update(ubos).set({ name: "Ravi SANCTIONED" }).where(eq(ubos.businessId, w.sellerId));
    expect(await rescreenParties(w.db, gw, T0)).toMatchObject({ screened: 2, hits: 1 });
    expect(await biz(w.sellerId)).toMatchObject({ kybStatus: "under_review", kybNote: "We need to review your verification again." });
    const [c] = await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, w.sellerId));
    expect(c).toMatchObject({ ruleTriggered: KYB_AML_RULE, status: "open", severity: "high" });
    expect(c.details).toMatchObject({ source: "periodic re-screening", matched: ["Ravi SANCTIONED"] });
    const told = (await sent("kyb_decision")).filter((n) => (n.body ?? "").includes("review your verification again"));
    expect(told.length).toBeGreaterThan(0);
    expect(told.map((n) => `${n.subject} ${n.body}`).join(" ")).not.toMatch(/sanction|pep|screen/i); // never tip the company off
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "aml.rescreen_hit"))).toHaveLength(1);
    expect((await rescreenParties(w.db, gw, day(10))).screened).toBe(1); // only the buyer: the seller is no longer approved
    expect(await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, w.sellerId))).toHaveLength(1);
  });

  it("a provider outage skips the company and tries again next run; it never passes or fails it", async () => {
    const down = { ...gw, kyc: { ...gw.kyc, screenAml: async () => { throw new Error("provider down"); } } } as Adapters;
    expect(await rescreenParties(w.db, down, T0)).toEqual({ screened: 0, hits: 0, failed: 2 });
    expect((await biz(w.sellerId)).amlScreenedAt).toBeNull();
    expect((await biz(w.sellerId)).kybStatus).toBe("approved");
    expect(await rescreenParties(w.db, gw, T0)).toMatchObject({ screened: 2 });
  });
});

describe("re-checking financed invoices' e-invoices", () => {
  const registry = (answer: "cancelled" | "missing" | "down" | "altered"): Adapters => ({ ...gw, irn: { getIrn: async (_i, claim) => {
    if (answer === "down") throw new Error("IRP unavailable");
    if (answer === "missing") return null;
    const c = claim ?? { amount: 0n, buyerGstin: "", sellerGstin: "", date: "" };
    return { ...c, amount: answer === "altered" ? c.amount + 1n : c.amount, cancelled: answer === "cancelled" };
  } } }) as Adapters;

  it("a cancelled e-invoice after payout opens a case, freezes the invoice, and tells the financier once", async () => {
    const { offer, invoiceId } = await w.financed();
    const fin = await w.financier("Capital One");
    await w.db.update(financingOffers).set({ financierId: fin.id }).where(eq(financingOffers.id, offer));
    expect(await recheckIrns(w.db, registry("cancelled"), T0)).toEqual({ checked: 1, flagged: 1, skipped: 0 });
    const [c] = await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, invoiceId));
    expect(c).toMatchObject({ ruleTriggered: "irn_cancelled", status: "open", severity: "high" });
    await expect(assertNotFrozen(w.db, invoiceId)).rejects.toThrow(/FROZEN_FRAUD_REVIEW/);
    expect((await sent("financed_invoice_flagged")).length).toBeGreaterThan(0);
    const before = (await sent("financed_invoice_flagged")).length;
    expect(await recheckIrns(w.db, registry("cancelled"), day(1))).toMatchObject({ flagged: 0 }); // same case, no second alert
    expect((await sent("financed_invoice_flagged")).length).toBe(before);
    expect(await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, invoiceId))).toHaveLength(1);
  });

  it("a vanished or altered record is flagged too; a clean one is only stamped as checked", async () => {
    const a = await w.financed(); const b = await w.financed();
    expect(await recheckIrns(w.db, registry("missing"), T0)).toMatchObject({ checked: 2, flagged: 2 });
    expect((await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, a.invoiceId)))[0].ruleTriggered).toBe("irn_not_found");
    await w.db.delete(fraudCases);
    expect(await recheckIrns(w.db, registry("altered"), day(1))).toMatchObject({ flagged: 2 });
    expect((await w.db.select().from(fraudCases).where(eq(fraudCases.entityId, b.invoiceId)))[0].ruleTriggered).toBe("irn_mismatch");
    await w.db.delete(fraudCases);
    expect(await recheckIrns(w.db, gw, day(2))).toMatchObject({ checked: 2, flagged: 0 });
    expect((await w.db.select().from(invoices).where(eq(invoices.id, a.invoiceId)))[0].irnRecheckedAt).toEqual(day(2));
  });

  it("an outage at the registry skips the invoice, and unfinanced or paid invoices are not looked up", async () => {
    await w.financed();
    expect(await recheckIrns(w.db, registry("down"), T0)).toEqual({ checked: 0, flagged: 0, skipped: 1 });
    expect((await w.db.select().from(invoices))[0].irnRecheckedAt).toBeNull();
    await w.db.update(invoices).set({ status: "paid" });
    expect(await recheckIrns(w.db, registry("cancelled"), T0)).toEqual({ checked: 0, flagged: 0, skipped: 0 });
  });
});

describe("periodic re-verification", () => {
  const input = (id: string) => ({ businessId: id, pan: "ABCDE1234F", gstin: "27AAAAA1111A1Z5", ubos: [{ name: "Ravi", shareholdingBps: 10000 }], bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Seller Co" } });

  it("approval starts the clock; a month before it lapses the company is told once; when it lapses it must verify again and financing waits", async () => {
    const approved = (await biz(w.sellerId)).kybApprovedAt!;
    expect(approved).toBeTruthy();
    const dueAt = new Date(approved); dueAt.setUTCMonth(dueAt.getUTCMonth() + MONITOR.rekycMonths);
    expect(await runRekyc(w.db, gw, day(-100, dueAt))).toEqual({ notified: 0, due: 0 });
    expect(await runRekyc(w.db, gw, day(-20, dueAt))).toEqual({ notified: 2, due: 0 }); // seller and buyer
    expect(await runRekyc(w.db, gw, day(-10, dueAt))).toEqual({ notified: 0, due: 0 }); // already told
    expect(await sent("kyb_rekyc_soon")).toHaveLength(2);
    expect(await runRekyc(w.db, gw, day(1, dueAt))).toEqual({ notified: 0, due: 2 });
    expect(await biz(w.sellerId)).toMatchObject({ kybStatus: "rekyc_due" });
    await expect(w.offered()).rejects.toThrow(); // no new financing for an unverified company
    // the company confirms its details again and is approved, with a fresh clock
    expect((await submitKyb(w.db, input(w.sellerId), gw)).status).toBe("approved");
    const after = await biz(w.sellerId);
    expect(after.kybStatus).toBe("approved");
    expect(after.kybApprovedAt!.getTime()).toBeGreaterThan(approved.getTime());
  });

  it("staff can ask an approved company to verify again; only staff, only with a reason, only when approved", async () => {
    const staff = { id: "00000000-0000-0000-0000-0000000000a1", role: "compliance" };
    await expect(requestRekyc(w.db, { ...staff, role: "seller" }, w.sellerId, "risk flag raised", gw, T0)).rejects.toThrow(/forbidden/);
    await expect(requestRekyc(w.db, staff, w.sellerId, "no", gw, T0)).rejects.toThrow(/say why/);
    await requestRekyc(w.db, staff, w.sellerId, "Director changed, please confirm", gw, T0);
    expect(await biz(w.sellerId)).toMatchObject({ kybStatus: "rekyc_due", kybNote: "Director changed, please confirm" });
    expect((await sent("kyb_rekyc_due")).length).toBeGreaterThan(0);
    await expect(requestRekyc(w.db, staff, w.sellerId, "again please", gw, T0)).rejects.toThrow(/only an approved company/);
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "kyb.rekyc_requested"))).toHaveLength(1);
  });
});

describe("licence expiry notices", () => {
  it("a financier is warned at 30 and again at 7 days, once each, and not after the licence has lapsed", async () => {
    const f = await w.financier("Capital One");
    const set = (d: string) => w.db.update(financierProfiles).set({ licenceValidUntil: d }).where(eq(financierProfiles.businessId, f.id));
    await set("2026-11-20");
    expect(await remindLicences(w.db, gw, T0)).toBe(0); // 45 days away
    expect(await remindLicences(w.db, gw, day(20))).toBe(1); // 25 days away: the 30-day notice
    expect(await remindLicences(w.db, gw, day(21))).toBe(0);
    expect(await remindLicences(w.db, gw, day(40))).toBe(1); // 5 days away: the 7-day notice
    expect(await remindLicences(w.db, gw, day(41))).toBe(0);
    expect((await sent("licence_expiring")).length).toBe(2);
    expect(await remindLicences(w.db, gw, day(60))).toBe(0); // lapsed: bidding has already stopped
    await set("2027-06-01");
    expect(await remindLicences(w.db, gw, day(220))).toBe(1); // a renewed licence gets its own notices
  });
});
