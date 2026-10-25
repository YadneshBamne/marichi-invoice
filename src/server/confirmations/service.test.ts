import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../testdb";
import { businesses, buyerSellerRelationships, invoiceConfirmations, invoices, notifications, users } from "../db/schema";
import { submitKyb, submitLightKyb } from "../kyb/service";
import { linkBuyer } from "../relationships/service";
import { createInvoice } from "../invoices/service";
import { mock } from "../integrations/mock";
import { dispatchValidated, respondToInvoice, respondViaApi, runConfirmationSla, sendForConfirmation, type Actor } from "./service";
import type { Database } from "../db/client";

const T0 = new Date("2026-10-06T00:00:00Z");
const hrs = (h: number) => new Date(T0.getTime() + h * 3_600_000);
let db: Database, sellerId: string, buyerId: string, invoiceId: string, buyer: Actor;

const sent: string[] = [];
const gw = { ...mock, notify: { send: async (p: { to: string; template: string }) => { sent.push(`${p.template}:${p.to}`); } } };

beforeEach(async () => {
  sent.length = 0;
  db = await testDb();
  sellerId = (await db.insert(businesses).values({ legalName: "Seller Co", entityType: "pvt_ltd" }).returning())[0].id;
  buyerId = (await db.insert(businesses).values({ legalName: "Big Corp", entityType: "pvt_ltd" }).returning())[0].id;
  await submitKyb(db, {
    businessId: sellerId, pan: "ABCDE1234F", gstin: "27AAAAA1111A1Z5", ubos: [{ name: "Ravi", shareholdingBps: 10000 }],
    bank: { accountNumber: "123456789012", ifsc: "HDFC0001234", holderName: "Seller Co" },
  });
  await submitLightKyb(db, { businessId: buyerId, gstin: "29BBBBB2222B1Z5", pan: "BCDEF2345G" });
  await linkBuyer(db, { sellerId, buyerGstin: "29BBBBB2222B1Z5", buyerEmail: "ap@big.com" });
  const [bu] = await db.insert(users).values([
    { name: "AP", email: "ap@big.com", role: "buyer", businessId: buyerId },
    { name: "Seller", email: "s@seller.com", role: "seller", businessId: sellerId },
    { name: "RM", email: "rm@marichi.com", role: "ops" },
  ]).returning();
  buyer = { id: bu.id, email: bu.email, role: "buyer", businessId: buyerId, ip: "1.2.3.4", userAgent: "vitest" };
  invoiceId = (await createInvoice(db, {
    sellerId, buyerId, invoiceNumber: "INV-1", invoiceDate: "2026-09-25", dueDate: "2026-12-01",
    amount: 5_00_000_00n, contentHash: "h1",
  }, mock, T0)).id;
  sent.length = 0;
});

const inv = async () => (await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0];
const conf = async () => (await db.select().from(invoiceConfirmations).where(eq(invoiceConfirmations.invoiceId, invoiceId)))[0];

describe("send", () => {
  it("moves validated -> sent_for_confirmation once, and notifies the buyer", async () => {
    expect(await sendForConfirmation(db, invoiceId, gw, T0)).toBe(true);
    expect(await sendForConfirmation(db, invoiceId, gw, T0)).toBe(false);
    expect((await inv()).status).toBe("sent_for_confirmation");
    expect(sent).toEqual(["confirmation_requested:ap@big.com"]);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });
  it("dispatchValidated sweeps stragglers", async () => {
    expect(await dispatchValidated(db, gw)).toBe(1);
    expect(await dispatchValidated(db, gw)).toBe(0);
  });
});

describe("respond", () => {
  beforeEach(async () => { await sendForConfirmation(db, invoiceId, gw, T0); sent.length = 0; });

  it("confirm -> eligible, with an audit trail (who, when, ip) and seller notified", async () => {
    expect((await respondToInvoice(db, { invoiceId, actor: buyer, decision: "confirm" }, gw, hrs(5))).status).toBe("eligible");
    expect(await conf()).toMatchObject({ status: "confirmed", method: "buyer", respondedByEmail: "ap@big.com", ip: "1.2.3.4" });
    expect((await inv()).confirmedAt).toBeTruthy();
    expect(sent).toEqual(["invoice_confirmed:s@seller.com"]);
  });

  it("dispute needs a note, flags the invoice, and blocks further responses", async () => {
    await expect(respondToInvoice(db, { invoiceId, actor: buyer, decision: "dispute" }, gw)).rejects.toThrow(/note/);
    await respondToInvoice(db, { invoiceId, actor: buyer, decision: "dispute", note: "Goods not received" }, gw, hrs(2));
    expect(await inv()).toMatchObject({ status: "disputed", disputeFlag: true });
    await expect(respondToInvoice(db, { invoiceId, actor: buyer, decision: "confirm" }, gw)).rejects.toThrow(/not awaiting/);
  });

  it("only the invoice's own buyer can respond", async () => {
    await expect(respondToInvoice(db, { invoiceId, actor: { ...buyer, businessId: sellerId }, decision: "confirm" }, gw)).rejects.toThrow("FORBIDDEN");
    await expect(respondToInvoice(db, { invoiceId, actor: { ...buyer, role: "seller" }, decision: "confirm" }, gw)).rejects.toThrow("FORBIDDEN");
  });

  it("clarification keeps the invoice open for a later confirm", async () => {
    await respondToInvoice(db, { invoiceId, actor: buyer, decision: "clarify", note: "Which PO?" }, gw);
    expect((await inv()).status).toBe("sent_for_confirmation");
    expect((await respondToInvoice(db, { invoiceId, actor: buyer, decision: "confirm" }, gw)).status).toBe("eligible");
  });

  it("confirming an invoice that has since become ineligible leaves it 'confirmed' for review", async () => {
    // 10 weeks later the due date (2026-12-01) is still ahead but the invoice is 90+ days old
    const r = await respondToInvoice(db, { invoiceId, actor: buyer, decision: "confirm" }, gw, new Date("2026-12-30T00:00:00Z"));
    expect(r.status).toBe("confirmed");
    expect((await inv()).reviewNote).toMatch(/due date|older/);
  });
});

describe("SLA sweep", () => {
  beforeEach(async () => { await sendForConfirmation(db, invoiceId, gw, T0); sent.length = 0; });

  it("nothing before 24h", async () => {
    expect(await runConfirmationSla(db, gw, hrs(23))).toEqual({ reminded: 0, escalated: 0, deemed: 0 });
  });
  it("24h and 48h reminders, then 72h escalation to seller + staff; each fires once", async () => {
    expect((await runConfirmationSla(db, gw, hrs(25))).reminded).toBe(1);
    expect((await runConfirmationSla(db, gw, hrs(26))).reminded).toBe(0);
    expect((await runConfirmationSla(db, gw, hrs(49))).reminded).toBe(1);
    expect((await runConfirmationSla(db, gw, hrs(73))).escalated).toBe(1);
    expect((await runConfirmationSla(db, gw, hrs(80))).escalated).toBe(0);
    expect(sent).toEqual([
      "confirmation_reminder:ap@big.com", "confirmation_reminder:ap@big.com",
      "confirmation_escalated:s@seller.com", "confirmation_escalated_rm:rm@marichi.com",
    ]);
  });
  it("after a long worker outage only the highest due stage is sent", async () => {
    await runConfirmationSla(db, gw, hrs(100));
    expect(sent).toEqual(["confirmation_escalated:s@seller.com", "confirmation_escalated_rm:rm@marichi.com"]);
  });
  it("deemed acceptance only when the buyer agreement enables it", async () => {
    expect((await runConfirmationSla(db, gw, hrs(24 * 5))).deemed).toBe(0);
    await db.update(buyerSellerRelationships).set({ deemedAcceptanceDays: 5 });
    expect((await runConfirmationSla(db, gw, hrs(24 * 5))).deemed).toBe(1);
    expect(await conf()).toMatchObject({ status: "confirmed", method: "deemed" });
    expect((await inv()).status).toBe("eligible");
  });
});

describe("the buyer's own system answers through the API", () => {
  beforeEach(async () => { await sendForConfirmation(db, invoiceId, gw, T0); });
  const api = (o: Partial<Parameters<typeof respondViaApi>[1]> = {}) => respondViaApi(db, { businessId: buyerId, keyId: "abcdef1234567890", invoiceNumber: "INV-1", decision: "confirm", ip: "9.9.9.9", ...o }, gw, T0);

  it("a confirmation is recorded as an API answer with the same wording, and the invoice moves on", async () => {
    expect((await api()).status).toBe("eligible");
    expect(await conf()).toMatchObject({ status: "confirmed", method: "api", respondedByEmail: "API key abcdef12", ip: "9.9.9.9" });
    expect((await conf()).acceptanceText).toMatch(/INV-1/);
    expect((await inv()).status).toBe("eligible");
  });

  it("a dispute needs a note and pauses the invoice; a question needs one too", async () => {
    await expect(api({ decision: "dispute" })).rejects.toThrow(/note is required/);
    expect((await api({ decision: "dispute", note: "wrong quantity" })).status).toBe("disputed");
    expect((await inv()).disputeFlag).toBe(true);
  });

  it("it cannot answer another company's invoice, an unknown number, or an invoice twice", async () => {
    const [other] = await db.insert(businesses).values({ legalName: "Other Buyer", entityType: "pvt_ltd" }).returning();
    await expect(api({ businessId: other.id })).rejects.toThrow(/NOT_FOUND/);
    await expect(api({ invoiceNumber: "NOPE" })).rejects.toThrow(/NOT_FOUND/);
    await api();
    await expect(api()).rejects.toThrow(/not awaiting confirmation/);
  });
});
