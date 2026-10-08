import { and, eq, inArray } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, invoiceConfirmations, invoices, buyerSellerRelationships } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { checkBasics } from "../invoices/service";
import { notifyBusiness, notifyStaff } from "../notify";
import { openDisputeInTx } from "../support/disputes";
import { announceTicket } from "../support/service";
import { formatINR } from "../../lib/money";

type Invoice = typeof invoices.$inferSelect;
export type Actor = { id: string; email: string; role: string; businessId: string | null; ip?: string; userAgent?: string };
export type Decision = "confirm" | "dispute" | "clarify";

const HOUR = 3_600_000;
const info = (i: Invoice) => ({ invoiceNumber: i.invoiceNumber, amount: formatINR(i.amount) });

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
  await notifyBusiness(db, inv.buyerId, "confirmation_requested", info(inv), gw);
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

/** Buyer responds. Only a user of the invoice's buyer business may respond. */
export async function respondToInvoice(
  db: Database, p: { invoiceId: string; actor: Actor; decision: Decision; note?: string }, gw: Adapters = gateway, now = new Date(),
) {
  const note = p.note?.trim();
  if (p.decision !== "confirm" && !note) throw new Error("a note is required to dispute or ask for clarification");

  const out = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");
    if (!inv) throw new Error("invoice not found");
    if (p.actor.role !== "buyer" || p.actor.businessId !== inv.buyerId) throw new Error("FORBIDDEN");
    if (inv.status !== "sent_for_confirmation") throw new Error(`invoice is not awaiting confirmation (${inv.status})`);

    let invoiceStatus: string = inv.status;
    let disputeTicketId: string | undefined;
    if (p.decision === "confirm") invoiceStatus = await applyConfirmed(tx, inv, now);
    if (p.decision === "dispute") {
      invoiceStatus = "disputed"; // pauses underwriting/funding; Module 16 owns resolution
      await tx.update(invoices).set({ status: "disputed", disputeFlag: true, reviewNote: note }).where(eq(invoices.id, inv.id));
      disputeTicketId = (await openDisputeInTx(tx, { invoice: inv, actor: p.actor, reason: note!, phase: "pre_funding", now })).id;
    }
    const confStatus = { confirm: "confirmed", dispute: "disputed", clarify: "clarification" }[p.decision];
    await tx.update(invoiceConfirmations).set({
      status: confStatus, method: "buyer", respondedAt: now, respondedBy: p.actor.id,
      respondedByEmail: p.actor.email, ip: p.actor.ip, userAgent: p.actor.userAgent, note,
    }).where(eq(invoiceConfirmations.invoiceId, inv.id));
    await tx.insert(auditLog).values({
      actorId: p.actor.id, action: `confirmation.${p.decision}`, entity: "invoice", entityId: inv.id,
      before: { status: inv.status }, after: { status: invoiceStatus, note },
    });
    return { inv, status: invoiceStatus, disputeTicketId };
  });
  if (out.disputeTicketId) await announceTicket(db, out.disputeTicketId, gw); // ack + alert support (after commit)

  const template = { confirm: "invoice_confirmed", dispute: "invoice_disputed", clarify: "invoice_clarification_requested" }[p.decision];
  await notifyBusiness(db, out.inv.sellerId, template, { ...info(out.inv), note: note ?? "" }, gw);
  return { status: out.status };
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
      await notifyBusiness(db, i.buyerId, "confirmation_reminder", info(i), gw);
      counts.reminded++;
    } else if (hrs >= 24 && !c.reminder24At && !c.reminder48At && !c.escalatedAt) {
      await db.update(invoiceConfirmations).set({ reminder24At: now }).where(eq(invoiceConfirmations.id, c.id));
      await notifyBusiness(db, i.buyerId, "confirmation_reminder", info(i), gw);
      counts.reminded++;
    }
  }
  return counts;
}
