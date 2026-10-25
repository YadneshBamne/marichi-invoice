import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, businesses, invoiceConfirmations, invoices, buyerSellerRelationships, memberships } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { checkBasics } from "../invoices/service";
import { notifyBusiness, notifyStaff } from "../notify";
import { emitEvent } from "../erp/events";
import { openDisputeInTx } from "../support/disputes";
import { announceTicket } from "../support/service";
import { formatMoney } from "../../lib/money";
import { ACCEPTANCE_VERSION, acceptanceText } from "./wording";
import { sendToBuyerSide } from "./link";
import { recordConfirmation } from "../agreements/records";

type Invoice = typeof invoices.$inferSelect;
export type Actor = { id: string; email: string; role: string; businessId: string | null; ip?: string; userAgent?: string };
export type Decision = "confirm" | "dispute" | "clarify";

const HOUR = 3_600_000;
const info = (i: Invoice) => ({ invoiceNumber: i.invoiceNumber, amount: formatMoney(i.amount) });

/** validated -> sent_for_confirmation, and tell the buyer. Atomic: only one caller can win the transition. */
export async function sendForConfirmation(db: Database, invoiceId: string, gw: Adapters = gateway, now = new Date()) {
  const inv = await db.transaction(async (tx) => {
    const [row] = await tx.update(invoices).set({ status: "sent_for_confirmation" })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.status, "validated"))).returning();
    if (!row) return null;
    await tx.insert(invoiceConfirmations).values({ invoiceId, sentAt: now });
    await tx.insert(auditLog).values({ action: "confirmation.sent", entity: "invoice", entityId: invoiceId });
    return row;
  });
  if (!inv) return false; // already sent, or not validated: idempotent no-op
  await sendToBuyerSide(db, inv, "confirmation_requested", gw, now);
  return true;
}

/** Safety net for the worker: dispatch anything validated but not yet sent (e.g. IRN recovered after an outage). */
export async function dispatchValidated(db: Database, gw: Adapters = gateway) {
  const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.status, "validated"));
  let n = 0;
  for (const r of rows) if (await sendForConfirmation(db, r.id, gw)) n++;
  return n;
}

/** Confirmed -> Eligible if it still passes the financing rules (age/ticket/dates); otherwise stays confirmed for review. */
async function applyConfirmed(tx: Tx, inv: Invoice, now: Date) {
  const reason = checkBasics(inv, now);
  const status = reason ? "confirmed" : "eligible";
  await tx.update(invoices).set({ status, confirmedAt: now, disputeFlag: false, reviewNote: reason })
    .where(eq(invoices.id, inv.id));
  return status as "confirmed" | "eligible";
}

export type Who = { userId: string | null; email: string; ip?: string; userAgent?: string; method: "buyer" | "link" };

/**
 * The one place an invoice response is applied, whether it came from a signed-in buyer user or from the emailed link.
 * `authorise` decides whether this person may answer for this invoice. The confirm wording the buyer saw is stored with the answer.
 */
export async function applyResponse(
  db: Database, p: { invoiceId: string; decision: Decision; note?: string; who: Who; authorise: (inv: Invoice) => void }, gw: Adapters = gateway, now = new Date(),
) {
  const note = p.note?.trim();
  if (p.decision !== "confirm" && !note) throw new Error("a note is required to dispute or ask for clarification");

  const out = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");
    if (!inv) throw new Error("invoice not found");
    p.authorise(inv);
    if (inv.status !== "sent_for_confirmation") throw new Error(`invoice is not awaiting confirmation (${inv.status})`);

    let invoiceStatus: string = inv.status;
    let disputeTicketId: string | undefined;
    if (p.decision === "confirm") invoiceStatus = await applyConfirmed(tx, inv, now);
    if (p.decision === "dispute") {
      invoiceStatus = "disputed"; // pauses underwriting/funding; Module 16 owns resolution
      await tx.update(invoices).set({ status: "disputed", disputeFlag: true, reviewNote: note }).where(eq(invoices.id, inv.id));
      disputeTicketId = (await openDisputeInTx(tx, { invoice: inv, actor: { id: p.who.userId ?? inv.buyerId, role: "buyer", businessId: inv.buyerId }, reason: note!, phase: "pre_funding", now })).id;
    }
    const [names] = await tx.select({ buyer: businesses.legalName, seller: sql<string>`(select legal_name from businesses where id = ${inv.sellerId})` }).from(businesses).where(eq(businesses.id, inv.buyerId));
    const claimable = p.who.method === "link" && p.decision === "confirm"
      ? (await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.businessId, inv.buyerId)).limit(1)).length === 0 : false;
    const confStatus = { confirm: "confirmed", dispute: "disputed", clarify: "clarification" }[p.decision];
    await tx.update(invoiceConfirmations).set({
      status: confStatus, method: p.who.method, respondedAt: now, respondedBy: p.who.userId,
      respondedByEmail: p.who.email, verifiedEmail: p.who.method === "link" ? p.who.email : null, ip: p.who.ip, userAgent: p.who.userAgent, note,
      ...(p.decision === "confirm" ? {
        acceptanceVersion: ACCEPTANCE_VERSION,
        acceptanceText: acceptanceText({ buyer: names.buyer, seller: names.seller, invoiceNumber: inv.invoiceNumber, amount: formatMoney(inv.amount), dueDate: inv.dueDate }).join("\n"),
      } : {}),
      ...(claimable ? { claimUntil: new Date(now.getTime() + 60 * 60_000) } : {}),
    }).where(eq(invoiceConfirmations.invoiceId, inv.id));
    // Confirming from the emailed link is the light verification of a buyer a supplier named: the address is proven and the GSTIN was screened when it was added.
    if (p.who.method === "link" && p.decision === "confirm") {
      await tx.update(businesses).set({ kybStatus: "approved", kybNote: null, kybApprovedAt: new Date() })
        .where(and(eq(businesses.id, inv.buyerId), eq(businesses.kybLevel, "light"), eq(businesses.kybStatus, "submitted")));
    }
    await tx.insert(auditLog).values({
      actorId: p.who.userId ?? undefined, action: `confirmation.${p.decision}`, entity: "invoice", entityId: inv.id,
      before: { status: inv.status }, after: { status: invoiceStatus, note, via: p.who.method, email: p.who.email },
    });
    return { inv, status: invoiceStatus, disputeTicketId };
  });
  if (out.disputeTicketId) await announceTicket(db, out.disputeTicketId, gw); // ack + alert support (after commit)
  if (p.decision === "confirm") await recordConfirmation(db, out.inv.id).catch((e) => console.error("[confirmation-record]", (e as Error).message));

  const template = { confirm: "invoice_confirmed", dispute: "invoice_disputed", clarify: "invoice_clarification_requested" }[p.decision];
  await notifyBusiness(db, out.inv.sellerId, template, { ...info(out.inv), note: note ?? "" }, gw);
  if (out.status === "confirmed" || out.status === "disputed") await emitEvent(db, out.inv.sellerId, out.status === "confirmed" ? "invoice.confirmed" : "invoice.disputed", { invoiceNumber: out.inv.invoiceNumber, note: note ?? null }, now);
  return { status: out.status, invoiceId: out.inv.id };
}

/** A signed-in user of the invoice's buyer business responds. */
export async function respondToInvoice(
  db: Database, p: { invoiceId: string; actor: Actor; decision: Decision; note?: string }, gw: Adapters = gateway, now = new Date(),
) {
  return applyResponse(db, {
    invoiceId: p.invoiceId, decision: p.decision, note: p.note,
    who: { userId: p.actor.id, email: p.actor.email, ip: p.actor.ip, userAgent: p.actor.userAgent, method: "buyer" },
    authorise: (inv) => { if (p.actor.role !== "buyer" || p.actor.businessId !== inv.buyerId) throw new Error("FORBIDDEN"); },
  }, gw, now);
}

/**
 * Worker job (PRD Module 4 SLA): reminders at 24h and 48h, escalation to seller + staff at 72h,
 * and optional deemed acceptance when the buyer agreement allows it. Idempotent; sends only the highest due stage.
 */
export async function runConfirmationSla(db: Database, gw: Adapters = gateway, now = new Date()) {
  const rows = await db
    .select({ c: invoiceConfirmations, i: invoices, deemed: buyerSellerRelationships.deemedAcceptanceDays })
    .from(invoiceConfirmations)
    .innerJoin(invoices, eq(invoices.id, invoiceConfirmations.invoiceId))
    .leftJoin(buyerSellerRelationships, and(
      eq(buyerSellerRelationships.buyerId, invoices.buyerId), eq(buyerSellerRelationships.sellerId, invoices.sellerId)))
    .where(and(eq(invoiceConfirmations.status, "pending"), inArray(invoices.status, ["sent_for_confirmation"])));

  const counts = { reminded: 0, escalated: 0, deemed: 0 };
  for (const { c, i, deemed } of rows) {
    const hrs = (now.getTime() - c.sentAt.getTime()) / HOUR;
    if (deemed != null && hrs >= deemed * 24) {
      await db.transaction(async (tx) => {
        const st = await applyConfirmed(tx, i, now);
        await tx.update(invoiceConfirmations).set({ status: "confirmed", method: "deemed", respondedAt: now, note: `deemed accepted after ${deemed} days` })
          .where(eq(invoiceConfirmations.id, c.id));
        await tx.insert(auditLog).values({ action: "confirmation.deemed", entity: "invoice", entityId: i.id, after: { status: st } });
      });
      await notifyBusiness(db, i.sellerId, "invoice_deemed_accepted", info(i), gw);
      counts.deemed++;
    } else if (hrs >= 72 && !c.escalatedAt) {
      await db.update(invoiceConfirmations).set({ escalatedAt: now }).where(eq(invoiceConfirmations.id, c.id));
      await notifyBusiness(db, i.sellerId, "confirmation_escalated", info(i), gw);
      await notifyStaff(db, ["ops", "admin"], "confirmation_escalated_rm", info(i), gw);
      counts.escalated++;
    } else if (hrs >= 48 && !c.reminder48At && !c.escalatedAt) {
      await db.update(invoiceConfirmations).set({ reminder48At: now }).where(eq(invoiceConfirmations.id, c.id));
      await sendToBuyerSide(db, i, "confirmation_reminder", gw, now);
      counts.reminded++;
    } else if (hrs >= 24 && !c.reminder24At && !c.reminder48At && !c.escalatedAt) {
      await db.update(invoiceConfirmations).set({ reminder24At: now }).where(eq(invoiceConfirmations.id, c.id));
      await sendToBuyerSide(db, i, "confirmation_reminder", gw, now);
      counts.reminded++;
    }
  }
  return counts;
}
