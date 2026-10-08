import { and, eq, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, fraudCases, invoices } from "../db/schema";
import { gateway, type Adapters, type IrnClaim } from "../integrations/gateway";
import { assertCanRaiseInvoice } from "../relationships/service";
import { openCase } from "../fraud/service";

// Illustrative defaults (PRD 3.3 / Module 3); move to the admin-console config (Module 15) later.
export const RULES = { maxAgeDays: 90, minTicket: 10_000_00n, maxTicket: 50_00_000_00n }; // editable at runtime (see config/policy.ts)

export type InvoiceStatus = typeof invoices.$inferSelect.status;
export type NewInvoice = {
  sellerId: string; buyerId: string;
  invoiceNumber: string; invoiceDate: string; dueDate: string; // YYYY-MM-DD
  amount: bigint; // paise
  irn?: string; poReference?: string; taxBreakup?: unknown; lineItems?: unknown;
  contentHash: string; documentRef?: string;
};

const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;

/** Pure rule check. Returns a rejection reason, or null if the invoice is financeable on its face. */
export function checkBasics(i: Pick<NewInvoice, "invoiceDate" | "dueDate" | "amount">, now = new Date(), r = RULES) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.invoiceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(i.dueDate)) return "dates must be YYYY-MM-DD";
  const today = Math.floor(now.getTime() / 86_400_000);
  if (day(i.invoiceDate) > today) return "invoice date is in the future";
  if (day(i.dueDate) <= day(i.invoiceDate)) return "due date must be after invoice date";
  if (day(i.dueDate) <= today) return "invoice is already past its due date";
  if (today - day(i.invoiceDate) > r.maxAgeDays) return `invoice is older than ${r.maxAgeDays} days`;
  if (i.amount < r.minTicket || i.amount > r.maxTicket) return "amount outside the financeable ticket range";
  return null;
}

type IrnResult = { irnStatus: "verified" | "mismatch" | "pending"; reason?: string };

/** Cross-check an IRN against the government registry (PRD 12.4). Throws for not-found / cancelled. */
export async function validateIrn(gw: Adapters, irn: string, claim: IrnClaim): Promise<IrnResult> {
  let rec;
  try {
    rec = await gw.irn.getIrn(irn, claim);
  } catch {
    return { irnStatus: "pending", reason: "IRP unavailable; will retry" }; // never reject on an outage
  }
  if (!rec) throw new Error("IRN_NOT_FOUND");
  if (rec.cancelled) throw new Error("IRN_CANCELLED");
  const same = rec.amount === claim.amount && rec.buyerGstin === claim.buyerGstin
    && rec.sellerGstin === claim.sellerGstin && rec.date === claim.date;
  return same ? { irnStatus: "verified" } : { irnStatus: "mismatch", reason: "invoice differs from government e-invoice record" };
}

/**
 * Capture + validate an invoice (Module 3). Ends at `validated`; Module 4 sends it for buyer confirmation.
 *  - Duplicates (same file, IRN, or seller+number) are rejected; a collision with ANOTHER seller opens a fraud case.
 *  - IRN mismatch -> stays `uploaded` with a fraud case (manual review). IRP outage -> `pending`, retried by the worker.
 *  - No IRN -> allowed (below e-invoice threshold) but flagged `absent` so underwriting can apply compensating controls.
 */
export async function createInvoice(db: Database, inv: NewInvoice, gw: Adapters = gateway, now = new Date()) {
  await assertCanRaiseInvoice(db, inv.sellerId, inv.buyerId);
  const bad = checkBasics(inv, now);
  if (bad) throw new Error(`INVALID_INVOICE: ${bad}`);

  const dupes = await db.select().from(invoices).where(or(
    eq(invoices.contentHash, inv.contentHash),
    inv.irn ? eq(invoices.irn, inv.irn) : undefined,
    and(eq(invoices.sellerId, inv.sellerId), eq(invoices.invoiceNumber, inv.invoiceNumber)),
  ));
  if (dupes.length) {
    const other = dupes.find((d) => d.sellerId !== inv.sellerId);
    if (other) {
      await openCase(db, {
        entityType: "invoice", entityId: other.id, rule: "duplicate_across_sellers", subjectBusinessId: inv.sellerId,
        details: { attemptedInvoiceNumber: inv.invoiceNumber, irn: inv.irn ?? null, originalSeller: other.sellerId },
      });
    }
    throw new Error("DUPLICATE_INVOICE");
  }

  let irnStatus: "absent" | "verified" | "mismatch" | "pending" = "absent";
  let reviewNote: string | undefined;
  if (inv.irn) {
    const [s, b] = await Promise.all([
      db.select({ g: businesses.gstin }).from(businesses).where(eq(businesses.id, inv.sellerId)),
      db.select({ g: businesses.gstin }).from(businesses).where(eq(businesses.id, inv.buyerId)),
    ]);
    const r = await validateIrn(gw, inv.irn, {
      amount: inv.amount, date: inv.invoiceDate, sellerGstin: s[0].g ?? "", buyerGstin: b[0].g ?? "",
    });
    irnStatus = r.irnStatus;
    reviewNote = r.reason;
  }

  const status: InvoiceStatus = irnStatus === "verified" || irnStatus === "absent" ? "validated" : "uploaded";
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(invoices).values({ ...inv, status, irnStatus, reviewNote }).returning();
      if (irnStatus === "mismatch") {
        await openCase(tx, { entityType: "invoice", entityId: row.id, rule: "irn_mismatch", subjectBusinessId: inv.sellerId, details: { irn: inv.irn, reason: reviewNote } });
      }
      await tx.insert(auditLog).values({
        action: "invoice.create", entity: "invoice", entityId: row.id, after: { status, irnStatus },
      });
      return { id: row.id, status, irnStatus };
    });
  } catch (e) {
    // Race: a concurrent identical upload won; the unique indexes are the real guard.
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") throw new Error("DUPLICATE_INVOICE");
    throw e;
  }
}

/** Worker job: re-check invoices parked because the IRP was down (PRD 12.4 retry). */
export async function revalidatePendingIrns(db: Database, gw: Adapters = gateway) {
  const pending = await db.select().from(invoices).where(eq(invoices.irnStatus, "pending"));
  let resolved = 0;
  for (const inv of pending) {
    const [s, b] = await Promise.all([
      db.select({ g: businesses.gstin }).from(businesses).where(eq(businesses.id, inv.sellerId)),
      db.select({ g: businesses.gstin }).from(businesses).where(eq(businesses.id, inv.buyerId)),
    ]);
    let r: IrnResult;
    try {
      r = await validateIrn(gw, inv.irn!, { amount: inv.amount, date: inv.invoiceDate, sellerGstin: s[0].g ?? "", buyerGstin: b[0].g ?? "" });
    } catch (e) {
      // Not found / cancelled after the fact: a fraud signal, not a retry case.
      await db.transaction(async (tx) => {
        await openCase(tx, { entityType: "invoice", entityId: inv.id, rule: `irn_${(e as Error).message.toLowerCase().replace(/^irn_/, "")}`, subjectBusinessId: inv.sellerId, details: { irn: inv.irn, found: "on re-check" } });
        await tx.update(invoices).set({ irnStatus: "mismatch", reviewNote: (e as Error).message }).where(eq(invoices.id, inv.id));
      });
      resolved++;
      continue;
    }
    if (r.irnStatus === "pending") continue;
    await db.transaction(async (tx) => {
      await tx.update(invoices)
        .set({ irnStatus: r.irnStatus, reviewNote: r.reason ?? null, status: r.irnStatus === "verified" ? "validated" : "uploaded" })
        .where(eq(invoices.id, inv.id));
      if (r.irnStatus === "mismatch") await openCase(tx, { entityType: "invoice", entityId: inv.id, rule: "irn_mismatch", subjectBusinessId: inv.sellerId, details: { irn: inv.irn, reason: r.reason } });
    });
    resolved++;
  }
  return resolved;
}
