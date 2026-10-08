import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { blacklist, businesses, fraudCases, invoices, notifications, strReports, users } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { createInvoice } from "../invoices/service";
import { dispatchValidated } from "../confirmations/service";
import { linkBuyer } from "../relationships/service";
import { submitKyb } from "../kyb/service";
import { underwriteInvoice } from "../underwriting/service";
import { generateOffer } from "../offers/service";
import { prepareAgreements, signInApp } from "../agreements/service";
import { executeDisbursement, fundEscrow, requestDisbursement } from "../disbursements/service";
import { mock } from "../integrations/mock";
import {
  addCaseNote, assertNotFrozen, assignCase, fileStr, isBlacklisted, liftBlacklist, listCases, notifyNewCases, openCase, resolveCase,
} from "./service";

let w: Awaited<ReturnType<typeof world>>;
const compliance = { id: "00000000-0000-0000-0000-0000000000c1", role: "compliance" };
const ops = { id: "00000000-0000-0000-0000-0000000000a1", role: "ops" };
const admin = { id: "00000000-0000-0000-0000-0000000000a2", role: "admin" };
beforeEach(async () => { w = await world(); });

const caseFor = async (invoiceId: string, rule = "manual_flag") =>
  (await openCase(w.db, { entityType: "invoice", entityId: invoiceId, rule, subjectBusinessId: w.sellerId })).id!;
const invoice = async (id: string) => (await w.db.select().from(invoices).where(eq(invoices.id, id)))[0];
let n = 0;
const rawInvoice = async (irn?: string) =>
  (await createInvoice(w.db, {
    sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: `RAW-${++n}`, invoiceDate: "2026-09-25", dueDate: "2026-11-20",
    amount: 10_00_000_00n, contentHash: `raw${n}`, irn,
  }, mock, T0)).id;

describe("openCase", () => {
  it("dedupes while open; a closed case allows a new one", async () => {
    const id = await rawInvoice();
    const a = await openCase(w.db, { entityType: "invoice", entityId: id, rule: "r1" });
    const b = await openCase(w.db, { entityType: "invoice", entityId: id, rule: "r1" });
    expect(a.created).toBe(true); expect(b.created).toBe(false);
    await resolveCase(w.db, { caseId: a.id!, staff: compliance, outcome: "cleared", note: "false positive" });
    expect((await openCase(w.db, { entityType: "invoice", entityId: id, rule: "r1" })).created).toBe(true);
  });
});

describe("freeze", () => {
  it("an open case stops underwriting, offers and payouts; clearing it releases them", async () => {
    const offer = await w.acceptedOffer();
    const [inv] = await w.db.select().from(invoices);
    const caseId = await caseFor(inv.id);
    await expect(assertNotFrozen(w.db, inv.id)).rejects.toThrow("FROZEN_FRAUD_REVIEW");
    await expect(generateOffer(w.db, inv.id, gw, T0)).rejects.toThrow("FROZEN_FRAUD_REVIEW");
    await prepareAgreements(w.db, offer, gw, T0);
    await signInApp(w.db, { offerId: offer, actor: w.sellerActor }, T0);
    await fundEscrow(w.db, { amount: 20_00_000_00n, ref: "f", staffId: ops.id, staffRole: "ops" });
    await expect(requestDisbursement(w.db, offer)).rejects.toThrow("FROZEN_FRAUD_REVIEW");
    await resolveCase(w.db, { caseId, staff: compliance, outcome: "cleared", note: "checked with buyer" });
    const d = await requestDisbursement(w.db, offer);
    expect(await executeDisbursement(w.db, d.id, gw, T0)).toEqual({ status: "succeeded" });
  });

  it("a case that opens after the payout was queued still stops the money", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    await signInApp(w.db, { offerId: offer, actor: w.sellerActor }, T0);
    await fundEscrow(w.db, { amount: 20_00_000_00n, ref: "f", staffId: ops.id, staffRole: "ops" });
    const d = await requestDisbursement(w.db, offer);
    await caseFor((await w.db.select().from(invoices))[0].id);
    await expect(executeDisbursement(w.db, d.id, gw, T0)).rejects.toThrow("FROZEN_FRAUD_REVIEW");
    expect((await w.db.select().from(invoices))[0].status).toBe("eligible"); // nothing moved
  });

  it("underwriting refuses a frozen invoice", async () => {
    const id = await rawInvoice();
    await w.db.update(invoices).set({ status: "eligible" }).where(eq(invoices.id, id));
    await caseFor(id);
    await expect(underwriteInvoice(w.db, id, gw, T0)).rejects.toThrow("FROZEN_FRAUD_REVIEW");
  });
});

describe("resolveCase", () => {
  it("IRN mismatch held at upload: clearing releases it into the normal flow", async () => {
    const id = await rawInvoice("MISMATCH-1");
    expect(await invoice(id)).toMatchObject({ status: "uploaded", irnStatus: "mismatch" });
    const [c] = await w.db.select().from(fraudCases);
    expect(c).toMatchObject({ ruleTriggered: "irn_mismatch", severity: "medium", subjectBusinessId: w.sellerId });
    await resolveCase(w.db, { caseId: c.id, staff: compliance, outcome: "cleared", note: "buyer confirmed amount by phone" });
    expect(await invoice(id)).toMatchObject({ status: "validated", irnStatus: "verified" });
    expect(await dispatchValidated(w.db, gw)).toBe(1);
  });

  it("confirmed fraud: invoice rejected, seller blacklisted everywhere, draft STR created, then filed", async () => {
    const id = await rawInvoice("MISMATCH-2");
    const [c] = await w.db.select().from(fraudCases);
    await resolveCase(w.db, { caseId: c.id, staff: compliance, outcome: "confirmed_fraud", note: "forged invoice" });
    expect(await invoice(id)).toMatchObject({ status: "rejected", disputeFlag: true });
    expect(await isBlacklisted(w.db, w.sellerId)).toBe(true);
    await expect(rawInvoice()).rejects.toThrow("BLACKLISTED"); // can't raise more invoices
    const [str] = await w.db.select().from(strReports);
    expect(str).toMatchObject({ status: "draft", caseId: c.id });
    await expect(fileStr(w.db, { caseId: c.id, reference: "", staff: compliance })).rejects.toThrow(/reference/);
    await expect(fileStr(w.db, { caseId: c.id, reference: "FIU-123", staff: ops })).rejects.toThrow("forbidden");
    await fileStr(w.db, { caseId: c.id, reference: "FIU-123", staff: compliance }, T0);
    expect((await w.db.select().from(strReports))[0]).toMatchObject({ status: "filed", reference: "FIU-123" });
    await expect(fileStr(w.db, { caseId: c.id, reference: "FIU-124", staff: compliance })).rejects.toThrow(/no draft/);
  });

  it("only admin can lift a ban; afterwards the seller can transact again", async () => {
    const id = await rawInvoice("MISMATCH-3");
    const [c] = await w.db.select().from(fraudCases);
    await resolveCase(w.db, { caseId: c.id, staff: admin, outcome: "confirmed_fraud", note: "x" });
    await expect(liftBlacklist(w.db, { businessId: w.sellerId, staff: compliance, note: "mistake" })).rejects.toThrow("forbidden");
    await expect(liftBlacklist(w.db, { businessId: w.sellerId, staff: admin, note: " " })).rejects.toThrow(/note/);
    await liftBlacklist(w.db, { businessId: w.sellerId, staff: admin, note: "reviewed; seller was a victim" });
    expect(await isBlacklisted(w.db, w.sellerId)).toBe(false);
    expect((await w.db.select().from(blacklist))[0].liftedAt).toBeTruthy();
    await expect(rawInvoice()).resolves.toBeTruthy();
    void id;
  });

  it("a duplicate attempt blacklists the ATTEMPTING seller, not the original", async () => {
    await rawInvoice("IRN-STOLEN");
    const s2 = (await w.db.insert(businesses).values({ legalName: "Seller Two", entityType: "pvt_ltd" }).returning())[0].id;
    await submitKyb(w.db, { businessId: s2, pan: "ABCDE1234F", gstin: "07CCCCC3333C1Z5", ubos: [{ name: "Sam", shareholdingBps: 10000 }],
      bank: { accountNumber: "999999999999", ifsc: "HDFC0001234", holderName: "Seller Two" } });
    await linkBuyer(w.db, { sellerId: s2, buyerGstin: "29BBBBB2222B1Z5", buyerEmail: "ap@big.com" });
    await expect(createInvoice(w.db, { sellerId: s2, buyerId: w.buyerId, invoiceNumber: "X", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10_00_000_00n, contentHash: "other", irn: "IRN-STOLEN" }, mock, T0)).rejects.toThrow("DUPLICATE_INVOICE");
    const [c] = await w.db.select().from(fraudCases);
    expect(c).toMatchObject({ ruleTriggered: "duplicate_across_sellers", severity: "high", subjectBusinessId: s2 });
    await resolveCase(w.db, { caseId: c.id, staff: compliance, outcome: "confirmed_fraud", note: "copied IRN" });
    expect(await isBlacklisted(w.db, s2)).toBe(true);
    expect(await isBlacklisted(w.db, w.sellerId)).toBe(false);
    // the ORIGINAL invoice must not be rejected just because someone copied it
    expect((await w.db.select().from(invoices).where(eq(invoices.sellerId, w.sellerId)))[0].status).not.toBe("rejected");
  });

  it("a blacklisted buyer also freezes invoices against it", async () => {
    const id = await rawInvoice();
    await w.db.insert(blacklist).values({ businessId: w.buyerId, reason: "x" });
    await expect(assertNotFrozen(w.db, id)).rejects.toThrow("BLACKLISTED");
  });

  it("guards: role, note, already closed, and KYB sanctions cases belong to the KYB queue", async () => {
    const id = await rawInvoice();
    const caseId = await caseFor(id);
    await expect(resolveCase(w.db, { caseId, staff: ops, outcome: "cleared", note: "x" })).rejects.toThrow("forbidden");
    await expect(resolveCase(w.db, { caseId, staff: compliance, outcome: "cleared", note: "  " })).rejects.toThrow(/note/);
    await resolveCase(w.db, { caseId, staff: compliance, outcome: "cleared", note: "fine" });
    await expect(resolveCase(w.db, { caseId, staff: compliance, outcome: "cleared", note: "again" })).rejects.toThrow(/already closed/);

    const kyb = (await openCase(w.db, { entityType: "business", entityId: w.buyerId, rule: "kyb_aml_hit", subjectBusinessId: w.buyerId })).id!;
    await expect(resolveCase(w.db, { caseId: kyb, staff: admin, outcome: "cleared", note: "x" })).rejects.toThrow(/KYB review/);
  });

  it("confirming fraud on an already-funded invoice leaves it in collections but still bans the seller", async () => {
    const offer = await w.acceptedOffer();
    await prepareAgreements(w.db, offer, gw, T0);
    await signInApp(w.db, { offerId: offer, actor: w.sellerActor }, T0);
    await fundEscrow(w.db, { amount: 20_00_000_00n, ref: "f", staffId: ops.id, staffRole: "ops" });
    await executeDisbursement(w.db, (await requestDisbursement(w.db, offer)).id, gw, T0);
    const [inv] = await w.db.select().from(invoices);
    const caseId = await caseFor(inv.id, "irn_cancelled");
    await resolveCase(w.db, { caseId, staff: compliance, outcome: "confirmed_fraud", note: "IRN cancelled after funding" });
    expect((await invoice(inv.id)).status).toBe("financed"); // money is out; recovery continues via collections
    expect(await isBlacklisted(w.db, w.sellerId)).toBe(true);
  });
});

describe("queue", () => {
  it("assign / notes need a handler role; list returns the full context", async () => {
    const id = await rawInvoice("MISMATCH-9");
    const [c] = await w.db.select().from(fraudCases);
    await expect(assignCase(w.db, c.id, { id: "x", role: "seller" })).rejects.toThrow("forbidden");
    await assignCase(w.db, c.id, ops);
    await addCaseNote(w.db, c.id, ops, "called buyer, awaiting reply");
    await expect(addCaseNote(w.db, c.id, ops, "  ")).rejects.toThrow(/empty/);
    const [row] = await listCases(w.db, "open");
    expect(row).toMatchObject({ assignedTo: ops.id, subjectName: "Seller Co", invoice: { seller: "Seller Co", buyer: "Big Corp", status: "uploaded" } });
    expect(row.notes.map((x) => x.note)).toEqual(["called buyer, awaiting reply"]);
    expect(await listCases(w.db, "closed")).toHaveLength(0);
    void id;
  });

  it("staff are alerted to each new case exactly once", async () => {
    await w.db.insert(users).values({ name: "Comp", email: "c@marichi.com", role: "compliance" });
    await rawInvoice("MISMATCH-7");
    expect(await notifyNewCases(w.db, gw)).toBe(1);
    expect(await notifyNewCases(w.db, gw)).toBe(0);
    expect((await w.db.select().from(notifications)).filter((x) => x.template === "fraud_case_opened")).toHaveLength(1);
  });
});
