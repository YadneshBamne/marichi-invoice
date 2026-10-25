// Debit notes: the seller adds a charge to an invoice the buyer has already accepted (extra freight, a price correction upward).
// What the buyer owes goes up, but the amount we may already have financed must not change under anyone's feet. So a debit note is
// raised as its own linked document: the buyer confirms it like any invoice, it is underwritten and financed on its own merits,
// and it is paid to its own collection account. The parent invoice is untouched.
import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, buyerSellerRelationships, invoices } from "../db/schema";
import { createInvoice } from "./service";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness } from "../notify";
import { formatMoney } from "../../lib/money";

// The parent must already be accepted by the buyer: a debit note on something nobody has confirmed adds nothing.
const ALLOWED = ["confirmed", "eligible", "financed", "due", "overdue", "paid"];
export type DebitActor = { id: string; role: string; businessId: string | null };

const day = (d: Date) => d.toISOString().slice(0, 10);
const plus = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

export async function issueDebitNote(db: Database, actor: DebitActor, p: { invoiceId: string; amount: bigint; reason: string }, gw: Adapters = gateway, now = new Date()) {
  const reason = p.reason.trim();
  if (reason.length < 3) throw new Error("give a reason for the debit note");
  const [parent] = await db.select().from(invoices).where(eq(invoices.id, p.invoiceId));
  if (!parent) throw new Error("invoice not found");
  if (actor.role !== "seller" || actor.businessId !== parent.sellerId) throw new Error("FORBIDDEN");
  if (parent.kind !== "invoice") throw new Error("a debit note is raised on an invoice, not on another debit note");
  if (parent.disputeFlag) throw new Error("this invoice is in dispute; settle that first");
  if (!ALLOWED.includes(parent.status)) throw new Error(`a debit note needs an invoice the buyer has accepted (this one is ${parent.status.replaceAll("_", " ")})`);
  if (p.amount <= 0n) throw new Error("the debit must be more than zero");

  const [{ n }] = await db.select({ n: count() }).from(invoices).where(and(eq(invoices.parentInvoiceId, parent.id)));
  const number = `DN-${parent.invoiceNumber}-${n + 1}`;
  // Due with the parent when that is still ahead; otherwise on the credit terms the two companies agreed.
  const today = day(now);
  let dueDate = parent.dueDate;
  if (dueDate <= today) {
    const [rel] = await db.select({ t: buyerSellerRelationships.creditTermsDays }).from(buyerSellerRelationships)
      .where(and(eq(buyerSellerRelationships.sellerId, parent.sellerId), eq(buyerSellerRelationships.buyerId, parent.buyerId)));
    dueDate = plus(today, rel?.t ?? 30);
  }
  const made = await createInvoice(db, {
    sellerId: parent.sellerId, buyerId: parent.buyerId, invoiceNumber: number, invoiceDate: today, dueDate, amount: p.amount,
    contentHash: createHash("sha256").update(`debit-note:${parent.id}:${number}:${p.amount}`).digest("hex"), poReference: parent.poReference ?? undefined,
    kind: "debit_note", parentInvoiceId: parent.id,
  }, gw, now);
  await db.insert(auditLog).values({ actorId: actor.id, action: "debitnote.issued", entity: "invoice", entityId: made.id, after: { parent: parent.id, number, amount: p.amount.toString(), reason } });
  await notifyBusiness(db, parent.buyerId, "debit_note_issued", { invoiceNumber: parent.invoiceNumber, debitNote: number, amount: formatMoney(p.amount), reason }, gw, now);
  return { id: made.id, number, status: made.status, dueDate };
}
