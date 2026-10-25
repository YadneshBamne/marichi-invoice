import { and, eq } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, collectionEvents, invoiceConfirmations, invoiceDisputes, invoices, ticketMessages, tickets } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { checkBasics } from "../invoices/service";
import { notifyBusiness } from "../notify";
import { formatMoney } from "../../lib/money";
import { announceTicket, insertTicket, type Actor } from "./service";
import { canWork, ticketNo } from "./policy";

type Invoice = typeof invoices.$inferSelect;
export type Outcome = "invoice_stands" | "upheld" | "credit_note";
const FUNDED = ["financed", "due", "overdue"];
const LABEL: Record<Outcome, string> = { invoice_stands: "invoice stands", upheld: "dispute upheld, invoice cancelled", credit_note: "credit note agreed" };

/**
 * Create the dispute ticket + dispute record inside the caller's transaction. Used by the buyer-confirmation
 * "dispute" response (pre-funding) so the ticket exists atomically with the invoice being paused.
 */
export async function openDisputeInTx(
  tx: Tx, p: { invoice: Invoice; actor: Actor; reason: string; phase: "pre_funding" | "post_funding"; disputedAmount?: bigint; now: Date },
) {
  const t = await insertTicket(tx, {
    kind: "dispute", subject: `Dispute: invoice ${p.invoice.invoiceNumber}`, description: p.reason, businessId: p.actor.businessId!,
    raisedBy: p.actor.id, raisedByRole: p.actor.role, invoiceId: p.invoice.id, now: p.now,
  });
  await tx.insert(invoiceDisputes).values({ ticketId: t.id, invoiceId: p.invoice.id, phase: p.phase, reason: p.reason, disputedAmount: p.disputedAmount, createdAt: p.now });
  return t;
}

/**
 * A buyer disputes an invoice that has ALREADY been financed (the PRD's post-disbursement case). Collections are
 * paused for it (dunning and recourse stop) until the dispute is resolved.
 */
export async function raiseDispute(
  db: Database, p: { invoiceId: string; actor: Actor; reason: string; disputedAmount?: bigint }, gw: Adapters = gateway, now = new Date(),
) {
  const reason = p.reason.trim();
  if (!reason) throw new Error("a reason is required");
  const t = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");
    if (!inv || p.actor.role !== "buyer" || p.actor.businessId !== inv.buyerId) throw new Error("FORBIDDEN");
    if (!FUNDED.includes(inv.status)) throw new Error(inv.status === "sent_for_confirmation" ? "dispute this from the confirmation screen" : `invoice cannot be disputed (${inv.status})`);
    if (p.disputedAmount !== undefined && (p.disputedAmount <= 0n || p.disputedAmount > inv.amount)) throw new Error("disputed amount must be between 0 and the invoice amount");
    const [open] = await tx.select({ id: invoiceDisputes.id }).from(invoiceDisputes).where(and(eq(invoiceDisputes.invoiceId, inv.id), eq(invoiceDisputes.status, "open")));
    if (open) throw new Error("DISPUTE_ALREADY_OPEN");
    await tx.update(invoices).set({ disputeFlag: true }).where(eq(invoices.id, inv.id)); // visible everywhere; collections check the dispute record
    return { ticket: await openDisputeInTx(tx, { invoice: inv, actor: p.actor, reason, phase: "post_funding", disputedAmount: p.disputedAmount, now }), inv };
  });
  await notifyBusiness(db, t.inv.sellerId, "invoice_disputed", { invoiceNumber: t.inv.invoiceNumber, amount: formatMoney(t.inv.amount), note: reason }, gw, now);
  await announceTicket(db, t.ticket.id, gw);
  return t.ticket;
}

/** True while a dispute is open on the invoice. Collections use this to pause reminders and the recourse trigger. */
export async function hasOpenDispute(db: Database | Tx, invoiceId: string) {
  const [d] = await db.select({ id: invoiceDisputes.id }).from(invoiceDisputes).where(and(eq(invoiceDisputes.invoiceId, invoiceId), eq(invoiceDisputes.status, "open")));
  return !!d;
}

/**
 * Close a dispute with an outcome. Staff (ops/admin) at the ticket's level, note required. The buyer's agreement is a
 * precondition recorded in the note: the platform doesn't unilaterally override a buyer.
 *
 * Pre-funding (invoice `disputed`):
 *   invoice_stands -> back into the flow (eligible); upheld -> invoice rejected; credit_note -> amount reduced, then eligible.
 * Post-funding (already paid out):
 *   invoice_stands -> collections resume; upheld -> clawback notice to the seller (recourse); credit_note -> shortfall notice
 *   (the buyer pays less, so the normal overdue/recourse flow recovers the difference).
 */
export async function resolveDispute(
  db: Database, p: { ticketId: string; staff: Actor; outcome: Outcome; note: string; creditNoteAmount?: bigint },
  gw: Adapters = gateway, now = new Date(),
) {
  const note = p.note.trim();
  if (!note) throw new Error("a resolution note is required");
  const out = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(tickets).where(eq(tickets.id, p.ticketId)).for("update");
    if (!t || t.kind !== "dispute") throw new Error("dispute ticket not found");
    if (!["ops", "admin"].includes(p.staff.role) || !canWork(p.staff.role, t.level)) throw new Error("forbidden");
    const [d] = await tx.select().from(invoiceDisputes).where(eq(invoiceDisputes.ticketId, t.id)).for("update");
    if (!d || d.status !== "open") throw new Error("dispute already resolved");
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, d.invoiceId)).for("update");

    let credit: bigint | null = null;
    if (p.outcome === "credit_note") {
      credit = p.creditNoteAmount ?? null;
      if (!credit || credit <= 0n || credit >= inv.amount) throw new Error("credit note must be more than 0 and less than the invoice amount");
    }

    if (d.phase === "pre_funding") {
      if (inv.status !== "disputed") throw new Error(`invoice is ${inv.status}, not disputed`);
      let status: Invoice["status"] = "rejected";
      let amount = inv.amount;
      if (p.outcome !== "upheld") {
        if (credit) amount = inv.amount - credit;
        const bad = checkBasics({ invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, amount }, now);
        status = bad ? "confirmed" : "eligible"; // `confirmed` = valid but needs a manual look (e.g. now too old); same as Module 4
        await tx.update(invoiceConfirmations).set({ status: "confirmed", method: "dispute_resolution", respondedAt: now, note }).where(eq(invoiceConfirmations.invoiceId, inv.id));
        await tx.update(invoices).set({ amount, status, disputeFlag: false, confirmedAt: now, reviewNote: bad ?? null }).where(eq(invoices.id, inv.id));
      } else {
        await tx.update(invoices).set({ status: "rejected", reviewNote: `dispute upheld: ${note}` }).where(eq(invoices.id, inv.id));
      }
    } else {
      if (!FUNDED.includes(inv.status)) throw new Error(`invoice is ${inv.status}, expected a funded invoice`);
      await tx.update(invoices).set({ disputeFlag: false }).where(eq(invoices.id, inv.id));
      if (p.outcome === "upheld") await tx.insert(collectionEvents).values({ invoiceId: inv.id, kind: "clawback_notice" }).onConflictDoNothing();
    }

    await tx.update(invoiceDisputes).set({ status: "resolved", outcome: p.outcome, creditNoteAmount: credit, resolutionNote: note, resolvedBy: p.staff.id, resolvedAt: now }).where(eq(invoiceDisputes.id, d.id));
    await tx.update(tickets).set({ status: "resolved", resolvedAt: now, updatedAt: now, firstResponseAt: t.firstResponseAt ?? now }).where(eq(tickets.id, t.id));
    await tx.insert(ticketMessages).values({ ticketId: t.id, authorId: p.staff.id, authorRole: p.staff.role, body: `Resolved: ${LABEL[p.outcome]}. ${note}`, createdAt: now });
    await tx.insert(auditLog).values({ actorId: p.staff.id, action: `dispute.${p.outcome}`, entity: "invoice", entityId: inv.id, after: { ticketId: t.id, note, credit: credit?.toString() ?? null } });
    return { t, d, inv, credit };
  });

  const no = ticketNo(out.t.seq);
  const data = { ticketNo: no, invoiceNumber: out.inv.invoiceNumber, outcome: LABEL[p.outcome], note };
  await notifyBusiness(db, out.inv.buyerId, "dispute_resolved", data, gw, now);
  await notifyBusiness(db, out.inv.sellerId, "dispute_resolved", data, gw, now);
  if (out.d.phase === "post_funding" && p.outcome === "upheld") await notifyBusiness(db, out.inv.sellerId, "clawback_notice", { invoiceNumber: out.inv.invoiceNumber, amount: formatMoney(out.inv.amount) }, gw, now);
  if (out.d.phase === "post_funding" && p.outcome === "credit_note") await notifyBusiness(db, out.inv.sellerId, "credit_note_shortfall", { invoiceNumber: out.inv.invoiceNumber, amount: formatMoney(out.credit!) }, gw, now);
}
