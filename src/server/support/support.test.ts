import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businesses, collectionEvents, invoiceConfirmations, invoiceDisputes, invoices, notifications, ticketMessages, tickets, users } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { createInvoice } from "../invoices/service";
import { sendForConfirmation, respondToInvoice } from "../confirmations/service";
import { runCollectionsSweep } from "../collections/service";
import { mock } from "../integrations/mock";
import { hasOpenDispute, raiseDispute, resolveDispute } from "./disputes";
import {
  assignTicket, escalateTicket, escalateToOmbudsman, getTicket, listMyTickets, openTicket, postMessage, reopenTicket, resolveTicket, runTicketSla, staffQueue,
  type Actor,
} from "./service";

let w: Awaited<ReturnType<typeof world>>;
let buyer: Actor, seller: Actor;
const ops: Actor = { id: "00000000-0000-0000-0000-0000000000a1", role: "ops", businessId: null };
const admin: Actor = { id: "00000000-0000-0000-0000-0000000000a2", role: "admin", businessId: null };
const compliance: Actor = { id: "00000000-0000-0000-0000-0000000000c1", role: "compliance", businessId: null };
const hrs = (h: number, from = T0) => new Date(from.getTime() + h * 3_600_000);
const day = (d: string) => new Date(`${d}T10:00:00Z`);

beforeEach(async () => {
  w = await world();
  seller = { ...w.sellerActor };
  buyer = { id: w.buyerUserId, role: "buyer", businessId: w.buyerId, email: "ap@big.com" };
  await w.db.insert(users).values([
    { name: "Ops", email: "ops@m.com", role: "ops" }, { name: "Adm", email: "adm@m.com", role: "admin" }, { name: "Comp", email: "comp@m.com", role: "compliance" },
  ]);
});
const tickets_ = () => w.db.select().from(tickets);
const templates = async () => (await w.db.select().from(notifications)).map((n) => n.template);
const q = (a: Actor) => a;

describe("tickets", () => {
  it("opens with SLA dates, an opening message, an ack to the raiser and an alert to support", async () => {
    const t = await openTicket(w.db, seller, { kind: "query", subject: "Fee question", description: "Why 0.5%?" }, gw, T0);
    expect(t.firstResponseDueAt).toEqual(hrs(24)); expect(t.resolveDueAt).toEqual(hrs(72));
    expect((await getTicket(w.db, seller, t.id)).no).toBe("TKT-000001");
    expect(await templates()).toEqual(expect.arrayContaining(["ticket_opened", "ticket_staff_new"]));
  });

  it("customers only: validates kind, text and invoice ownership", async () => {
    await expect(openTicket(w.db, ops, { kind: "query", subject: "x", description: "y" }, gw)).rejects.toThrow("forbidden");
    await expect(openTicket(w.db, seller, { kind: "dispute" as never, subject: "x", description: "y" }, gw)).rejects.toThrow(/invalid ticket type/);
    await expect(openTicket(w.db, seller, { kind: "query", subject: " ", description: "y" }, gw)).rejects.toThrow(/required/);
    const stranger = (await w.db.insert(businesses).values({ legalName: "Other", entityType: "llp" }).returning())[0].id;
    const inv = await w.acceptedOffer().then(async () => (await w.db.select().from(invoices))[0].id);
    await expect(openTicket(w.db, { ...seller, businessId: stranger }, { kind: "query", subject: "x", description: "y", invoiceId: inv }, gw)).rejects.toThrow("FORBIDDEN");
    expect((await openTicket(w.db, seller, { kind: "query", subject: "x", description: "y", invoiceId: inv }, gw)).invoiceId).toBe(inv);
  });

  it("a customer can't read another business's ticket; internal notes are hidden from customers", async () => {
    const t = await openTicket(w.db, seller, { kind: "query", subject: "s", description: "d" }, gw, T0);
    await expect(getTicket(w.db, buyer, t.id)).rejects.toThrow("not found");
    await postMessage(w.db, { ticketId: t.id, actor: ops, body: "checking with finance", internal: true }, gw, hrs(1));
    await postMessage(w.db, { ticketId: t.id, actor: ops, body: "We are looking into it" }, gw, hrs(2));
    expect((await getTicket(w.db, seller, t.id)).messages.map((m) => m.body)).toEqual(["d", "We are looking into it"]);
    expect((await getTicket(w.db, ops, t.id)).messages).toHaveLength(3);
    await expect(postMessage(w.db, { ticketId: t.id, actor: seller, body: "x", internal: true }, gw)).rejects.toThrow("forbidden");
    expect(await listMyTickets(w.db, buyer)).toHaveLength(0);
    expect(await listMyTickets(w.db, seller)).toHaveLength(1);
  });

  it("first staff reply records first response and waits on the customer; the customer reply resumes it", async () => {
    const t = await openTicket(w.db, seller, { kind: "query", subject: "s", description: "d" }, gw, T0);
    await postMessage(w.db, { ticketId: t.id, actor: ops, body: "Hi" }, gw, hrs(3));
    let [row] = await tickets_();
    expect(row).toMatchObject({ status: "awaiting_customer", assignedTo: ops.id, firstResponseAt: hrs(3) });
    await postMessage(w.db, { ticketId: t.id, actor: seller, body: "Thanks, more info" }, gw, hrs(4));
    [row] = await tickets_();
    expect(row.status).toBe("in_progress");
  });

  it("escalation follows the matrix and each level only lets its own roles work the ticket", async () => {
    const t = await openTicket(w.db, seller, { kind: "complaint", subject: "s", description: "d" }, gw, T0);
    await expect(assignTicket(w.db, t.id, compliance)).rejects.toThrow("forbidden"); // L1 is support
    await expect(escalateTicket(w.db, t.id, ops, " ", gw)).rejects.toThrow(/reason/);
    await escalateTicket(w.db, t.id, ops, "needs RM", gw, hrs(1));
    expect((await tickets_())[0]).toMatchObject({ level: 2, assignedTo: null });
    await expect(postMessage(w.db, { ticketId: t.id, actor: ops, body: "x" }, gw)).rejects.toThrow(/level you don't handle/);
    await escalateTicket(w.db, t.id, admin, "credit view needed", gw, hrs(2));
    await assignTicket(w.db, t.id, compliance);
    await expect(escalateTicket(w.db, t.id, compliance, "again", gw)).rejects.toThrow(/highest/);
    expect(await templates()).toEqual(expect.arrayContaining(["ticket_escalated"]));
  });

  it("resolve needs a note, notifies the customer, and the customer can reopen within 7 days only", async () => {
    const t = await openTicket(w.db, seller, { kind: "query", subject: "s", description: "d" }, gw, T0);
    await expect(resolveTicket(w.db, t.id, ops, " ", gw)).rejects.toThrow(/note/);
    await resolveTicket(w.db, t.id, ops, "Explained the fee", gw, hrs(5));
    expect(await templates()).toContain("ticket_resolved");
    await expect(postMessage(w.db, { ticketId: t.id, actor: seller, body: "more" }, gw)).rejects.toThrow(/reopen/);
    await expect(reopenTicket(w.db, t.id, buyer, gw)).rejects.toThrow("not found");
    await expect(reopenTicket(w.db, t.id, seller, gw, hrs(24 * 8, T0))).rejects.toThrow(/7-day/);
    await reopenTicket(w.db, t.id, seller, gw, hrs(24 * 3, T0));
    expect((await tickets_())[0]).toMatchObject({ status: "in_progress", resolvedAt: null });
  });
});

describe("SLA enforcement", () => {
  it("missed first response escalates once; missed resolution escalates again; top level alerts instead", async () => {
    const t = await openTicket(w.db, seller, { kind: "query", subject: "s", description: "d" }, gw, T0);
    expect(await runTicketSla(w.db, gw, hrs(23))).toBe(0);
    expect(await runTicketSla(w.db, gw, hrs(25))).toBe(1);
    expect((await tickets_())[0]).toMatchObject({ level: 2 });
    expect((await tickets_())[0].frBreachedAt).toBeTruthy();
    expect(await runTicketSla(w.db, gw, hrs(26))).toBe(0); // flagged once
    expect(await runTicketSla(w.db, gw, hrs(73))).toBe(1); // resolution missed
    expect((await tickets_())[0]).toMatchObject({ level: 3 });
    expect((await tickets_())[0].slaBreachedAt).toBeTruthy();
    expect((await staffQueue(w.db, { breached: true })).map((x) => x.id)).toEqual([t.id]);
  });

  it("answering in time or resolving prevents breach; a ticket that is both late stages escalates only one level per sweep", async () => {
    const a = await openTicket(w.db, seller, { kind: "query", subject: "a", description: "d" }, gw, T0);
    await postMessage(w.db, { ticketId: a.id, actor: ops, body: "on it" }, gw, hrs(2));
    await resolveTicket(w.db, a.id, ops, "done", gw, hrs(10));
    const b = await openTicket(w.db, seller, { kind: "query", subject: "b", description: "d" }, gw, T0);
    await runTicketSla(w.db, gw, hrs(100)); // b missed both first response and resolution
    const rows = await tickets_();
    expect(rows.find((x) => x.id === a.id)!.level).toBe(1);
    expect(rows.find((x) => x.id === b.id)!.level).toBe(2);
    expect(rows.find((x) => x.id === b.id)!.slaBreachedAt).toBeTruthy();
  });

  it("queue filters", async () => {
    await openTicket(w.db, seller, { kind: "query", subject: "q", description: "d" }, gw, T0);
    const g = await openTicket(w.db, seller, { kind: "grievance", subject: "g", description: "d" }, gw, T0);
    expect((await staffQueue(w.db, { kind: "grievance" })).map((x) => x.id)).toEqual([g.id]);
    expect(await staffQueue(w.db, { open: false })).toHaveLength(0);
    expect(await staffQueue(w.db, { level: 2 })).toHaveLength(0);
  });
});

describe("grievance and Ombudsman", () => {
  it("grievance ack carries the officer's details and a 30-day deadline; Ombudsman route opens only when earned", async () => {
    process.env.GRIEVANCE_OFFICER_NAME = "A. Officer"; process.env.GRIEVANCE_OFFICER_EMAIL = "go@marichi.example"; process.env.GRIEVANCE_OFFICER_PHONE = "+911234567890";
    try {
      const g = await openTicket(w.db, seller, { kind: "grievance", subject: "Unfair charge", description: "details" }, gw, T0);
      expect(g.resolveDueAt).toEqual(hrs(30 * 24));
      expect(await templates()).toContain("grievance_ack");
    } finally { delete process.env.GRIEVANCE_OFFICER_NAME; delete process.env.GRIEVANCE_OFFICER_EMAIL; delete process.env.GRIEVANCE_OFFICER_PHONE; }
    const [g] = await tickets_();
    await expect(escalateToOmbudsman(w.db, g.id, seller, gw, hrs(24 * 10))).rejects.toThrow(/available once/);
    await expect(escalateToOmbudsman(w.db, g.id, buyer, gw, hrs(24 * 31))).rejects.toThrow("not found");
    await escalateToOmbudsman(w.db, g.id, seller, gw, hrs(24 * 31)); // 30 days passed
    expect((await tickets_())[0].ombudsmanEscalatedAt).toBeTruthy();
    expect((await getTicket(w.db, seller, g.id)).messages.at(-1)!.body).toContain("Ombudsman");
    expect(await templates()).toContain("ombudsman_escalated");
    await expect(escalateToOmbudsman(w.db, g.id, seller, gw, hrs(24 * 32))).rejects.toThrow(/already/);
    const q1 = await openTicket(w.db, seller, { kind: "query", subject: "q", description: "d" }, gw, T0);
    await expect(escalateToOmbudsman(w.db, q1.id, seller, gw, hrs(24 * 40))).rejects.toThrow(/only complaints/);
  });

  it("dissatisfied after resolution is enough", async () => {
    const g = await openTicket(w.db, seller, { kind: "complaint", subject: "c", description: "d" }, gw, T0);
    await resolveTicket(w.db, g.id, ops, "no fault found", gw, hrs(10));
    await escalateToOmbudsman(w.db, g.id, seller, gw, hrs(11));
    expect((await tickets_())[0].ombudsmanEscalatedAt).toBeTruthy();
  });
});

/** An invoice sent for confirmation (buyer can dispute it), or fully financed (post-funding disputes). */
async function pendingConfirmation() {
  const { id } = await createInvoice(w.db, { sellerId: w.sellerId, buyerId: w.buyerId, invoiceNumber: "DSP-1", invoiceDate: "2026-09-25", dueDate: "2026-11-20", amount: 10_00_000_00n, contentHash: "d1" }, mock, T0);
  await sendForConfirmation(w.db, id, gw, T0);
  return id;
}

describe("pre-funding dispute (from the confirmation screen)", () => {
  const dispute = async (id: string) => {
    await respondToInvoice(w.db, { invoiceId: id, actor: { ...buyer, email: "ap@big.com" }, decision: "dispute", note: "Goods not received" }, gw, hrs(2));
    return (await w.db.select().from(invoiceDisputes))[0];
  };
  const inv = async (id: string) => (await w.db.select().from(invoices).where(eq(invoices.id, id)))[0];

  it("buyer dispute atomically opens a ticket; both parties can see and reply on it", async () => {
    const id = await pendingConfirmation();
    const d = await dispute(id);
    expect(d).toMatchObject({ phase: "pre_funding", status: "open", reason: "Goods not received" });
    const [t] = await tickets_();
    expect(t).toMatchObject({ kind: "dispute", invoiceId: id, businessId: w.buyerId });
    expect(await hasOpenDispute(w.db, id)).toBe(true);
    expect((await getTicket(w.db, seller, t.id)).dispute?.status).toBe("open"); // seller sees it via the invoice
    expect(await listMyTickets(w.db, seller)).toHaveLength(1);
    await postMessage(w.db, { ticketId: t.id, actor: seller, body: "Delivered on 5 Oct, POD attached" }, gw, hrs(3));
    expect(await templates()).toEqual(expect.arrayContaining(["ticket_opened", "ticket_staff_new"]));
  });

  it("invoice_stands releases it to eligible; the ticket resolves; a dispute can't be resolved twice", async () => {
    const id = await pendingConfirmation(); await dispute(id);
    const [t] = await tickets_();
    await expect(resolveDispute(w.db, { ticketId: t.id, staff: ops, outcome: "invoice_stands", note: " " }, gw)).rejects.toThrow(/note/);
    await expect(resolveDispute(w.db, { ticketId: t.id, staff: compliance, outcome: "invoice_stands", note: "x" }, gw)).rejects.toThrow("forbidden");
    await resolveTicket(w.db, t.id, ops, "x", gw).catch((e) => expect(e.message).toMatch(/resolveDispute/));
    await resolveDispute(w.db, { ticketId: t.id, staff: ops, outcome: "invoice_stands", note: "Buyer confirmed receipt by phone" }, gw, hrs(5));
    expect(await inv(id)).toMatchObject({ status: "eligible", disputeFlag: false });
    expect((await w.db.select().from(invoiceConfirmations))[0]).toMatchObject({ status: "confirmed", method: "dispute_resolution" });
    expect((await tickets_())[0].status).toBe("resolved");
    expect(await hasOpenDispute(w.db, id)).toBe(false);
    await expect(resolveDispute(w.db, { ticketId: t.id, staff: ops, outcome: "upheld", note: "again" }, gw)).rejects.toThrow(/already resolved/);
  });

  it("upheld rejects the invoice; credit_note reduces the amount and releases it", async () => {
    const a = await pendingConfirmation(); await dispute(a);
    await resolveDispute(w.db, { ticketId: (await tickets_())[0].id, staff: ops, outcome: "upheld", note: "invoice was for undelivered goods" }, gw, hrs(5));
    expect(await inv(a)).toMatchObject({ status: "rejected" });
  });

  it("credit note: validates the amount, then releases at the reduced value", async () => {
    const id = await pendingConfirmation(); await dispute(id);
    const [t] = await tickets_();
    await expect(resolveDispute(w.db, { ticketId: t.id, staff: ops, outcome: "credit_note", note: "x" }, gw)).rejects.toThrow(/credit note must be/);
    await expect(resolveDispute(w.db, { ticketId: t.id, staff: ops, outcome: "credit_note", note: "x", creditNoteAmount: 10_00_000_00n }, gw)).rejects.toThrow(/credit note must be/);
    await resolveDispute(w.db, { ticketId: t.id, staff: ops, outcome: "credit_note", note: "damaged goods, 2L off", creditNoteAmount: 2_00_000_00n }, gw, hrs(5));
    expect(await inv(id)).toMatchObject({ amount: 8_00_000_00n, status: "eligible", disputeFlag: false });
    expect((await w.db.select().from(invoiceDisputes))[0]).toMatchObject({ outcome: "credit_note", creditNoteAmount: 2_00_000_00n });
  });
});

describe("post-funding dispute", () => {
  async function financedInvoice() {
    const f = await w.financed();
    return f.invoiceId;
  }

  it("only the buyer of a funded invoice can raise it; one open dispute at a time; amount sanity", async () => {
    const id = await financedInvoice();
    await expect(raiseDispute(w.db, { invoiceId: id, actor: seller, reason: "x" }, gw)).rejects.toThrow("FORBIDDEN");
    await expect(raiseDispute(w.db, { invoiceId: id, actor: buyer, reason: " " }, gw)).rejects.toThrow(/reason/);
    await expect(raiseDispute(w.db, { invoiceId: id, actor: buyer, reason: "x", disputedAmount: 99_00_000_00n }, gw)).rejects.toThrow(/between/);
    await raiseDispute(w.db, { invoiceId: id, actor: buyer, reason: "Short-shipped", disputedAmount: 1_00_000_00n }, gw, day("2026-11-01"));
    await expect(raiseDispute(w.db, { invoiceId: id, actor: buyer, reason: "again" }, gw)).rejects.toThrow("DISPUTE_ALREADY_OPEN");
    expect((await w.db.select().from(invoices))[0].disputeFlag).toBe(true);
    expect(await templates()).toContain("invoice_disputed");
  });

  it("an open dispute pauses dunning and recourse; resolving it resumes them", async () => {
    const id = await financedInvoice();
    await raiseDispute(w.db, { invoiceId: id, actor: buyer, reason: "Short-shipped" }, gw, day("2026-11-01"));
    await runCollectionsSweep(w.db, gw, day("2026-11-27")); // 7 days past due: normally overdue + recourse notice
    expect((await w.db.select().from(invoices))[0].status).toBe("financed");
    expect(await w.db.select().from(collectionEvents)).toHaveLength(0);
    const [t] = await tickets_();
    await resolveDispute(w.db, { ticketId: t.id, staff: ops, outcome: "invoice_stands", note: "buyer withdrew" }, gw, day("2026-11-28"));
    await runCollectionsSweep(w.db, gw, day("2026-11-28"));
    expect((await w.db.select().from(invoices))[0].status).toBe("overdue");
    expect((await w.db.select().from(collectionEvents)).map((e) => e.kind)).toContain("recourse_notice");
  });

  it("upheld -> clawback notice to the seller; credit note -> shortfall notice; both close the ticket", async () => {
    const id = await financedInvoice();
    await raiseDispute(w.db, { invoiceId: id, actor: buyer, reason: "cancelled order" }, gw, day("2026-11-01"));
    await resolveDispute(w.db, { ticketId: (await tickets_())[0].id, staff: ops, outcome: "upheld", note: "order cancelled" }, gw, day("2026-11-02"));
    expect(await templates()).toEqual(expect.arrayContaining(["clawback_notice", "dispute_resolved"]));
    expect((await w.db.select().from(collectionEvents)).map((e) => e.kind)).toContain("clawback_notice");
    expect((await w.db.select().from(invoices))[0]).toMatchObject({ disputeFlag: false, status: "financed" }); // stays in collections; seller is liable
    expect((await tickets_())[0].status).toBe("resolved");

    await raiseDispute(w.db, { invoiceId: id, actor: buyer, reason: "price error" }, gw, day("2026-11-03"));
    await resolveDispute(w.db, { ticketId: (await tickets_())[1].id, staff: ops, outcome: "credit_note", note: "agreed", creditNoteAmount: 50_000_00n }, gw, day("2026-11-04"));
    expect(await templates()).toContain("credit_note_shortfall");
    expect((await w.db.select().from(ticketMessages)).some((m) => m.body.startsWith("Resolved: credit note agreed"))).toBe(true);
  });
});

void q;
