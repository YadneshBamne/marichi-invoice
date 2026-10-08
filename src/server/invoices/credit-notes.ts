// Credit notes: the seller reduces what an invoice is worth (goods returned, a discount agreed). The invoice amount drops by
// the credit and the buyer is told. What else happens depends on how far the invoice has got:
//   before funding  -> any open offer is withdrawn, so the next offer is priced on the new amount;
//   after funding   -> the buyer will pay less, and the seller is responsible for the shortfall under the agreement.
// An accepted offer that is not yet paid out blocks a credit note: cancel that first, so we never pay out on a stale amount.
import { count, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, creditNotes, financingOffers, invoices } from "../db/schema";
import { gateway, type Adapters } from "./../integrations/gateway";
import { notifyBusiness } from "../notify";
import { emitEvent } from "../erp/events";
import { formatINR } from "../../lib/money";

const PRE = ["uploaded", "validated", "sent_for_confirmation", "confirmed", "eligible"];
const POST = ["financed", "due", "overdue"];
export type CreditActor = { id: string; role: string; businessId: string | null };

export async function issueCreditNote(db: Database, actor: CreditActor, p: { invoiceId: string; amount: bigint; reason: string }, gw: Adapters = gateway, now = new Date()) {
  const reason = p.reason.trim();
  if (reason.length < 3) throw new Error("give a reason for the credit note");
  const out = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");
    if (!inv) throw new Error("invoice not found");
    if (actor.role !== "seller" || actor.businessId !== inv.sellerId) throw new Error("FORBIDDEN");
    if (inv.disputeFlag) throw new Error("this invoice is in dispute; the credit is settled through the dispute");
    const phase = PRE.includes(inv.status) ? "pre_funding" : POST.includes(inv.status) ? "post_funding" : null;
    if (!phase) throw new Error(`a credit note cannot be issued on a ${inv.status.replaceAll("_", " ")} invoice`);
    if (p.amount <= 0n || p.amount >= inv.amount) throw new Error("the credit must be more than zero and less than the invoice amount");

    const offers = await tx.select().from(financingOffers).where(eq(financingOffers.invoiceId, inv.id));
    if (phase === "pre_funding") {
      if (offers.some((o) => o.status === "accepted")) throw new Error("an accepted offer is waiting for signature and payout; ask support to cancel it before issuing a credit note");
      for (const o of offers.filter((x) => x.status === "open")) {
        await tx.update(financingOffers).set({ status: "rejected" }).where(eq(financingOffers.id, o.id));
        await tx.insert(auditLog).values({ actorId: actor.id, action: "offer.withdrawn_credit_note", entity: "invoice", entityId: inv.id, after: { offerId: o.id } });
      }
    }

    const [{ n }] = await tx.select({ n: count() }).from(creditNotes).where(eq(creditNotes.invoiceId, inv.id));
    const number = `CN-${inv.invoiceNumber}-${n + 1}`;
    const newAmount = inv.amount - p.amount;
    await tx.update(invoices).set({ amount: newAmount }).where(eq(invoices.id, inv.id));
    const [note] = await tx.insert(creditNotes).values({ invoiceId: inv.id, number, amount: p.amount, amountBefore: inv.amount, reason, phase, issuedBy: actor.id }).returning();
    await tx.insert(auditLog).values({ actorId: actor.id, action: "creditnote.issued", entity: "invoice", entityId: inv.id, before: { amount: inv.amount.toString() }, after: { amount: newAmount.toString(), creditNote: number, phase, reason } });
    return { note, inv, newAmount, phase };
  });

  const data = { invoiceNumber: out.inv.invoiceNumber, creditNote: out.note.number, amount: formatINR(p.amount), newAmount: formatINR(out.newAmount), reason };
  await notifyBusiness(db, out.inv.buyerId, "credit_note_issued", data, gw, now);
  const cn = { invoiceNumber: out.inv.invoiceNumber, creditNote: out.note.number, creditPaise: p.amount.toString(), newAmountPaise: out.newAmount.toString(), reason };
  await emitEvent(db, out.inv.sellerId, "invoice.credit_note", cn, now);
  await emitEvent(db, out.inv.buyerId, "invoice.credit_note", cn, now);
  if (out.phase === "post_funding") await notifyBusiness(db, out.inv.sellerId, "credit_note_shortfall", { invoiceNumber: out.inv.invoiceNumber, amount: formatINR(p.amount) }, gw, now);
  return { creditNote: out.note, newAmount: out.newAmount, phase: out.phase };
}

export const listCreditNotes = (db: Database, invoiceIds: string[]) =>
  invoiceIds.length ? db.select().from(creditNotes).where(inArray(creditNotes.invoiceId, invoiceIds)) : Promise.resolve([]);
