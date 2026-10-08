// Creating and reading invoices on behalf of an outside system (REST API and CSV import). One code path, so both go through
// exactly the same checks as an upload in the app: duplicate detection, e-invoice check, limits and the fraud scan.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { businesses, buyerSellerRelationships, disbursements, financingOffers, invoiceCollections, invoices } from "../db/schema";
import { createInvoice } from "../invoices/service";
import { putDocument } from "../vault";
import { rupeesToPaise, toDecimal } from "../../lib/money";

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
export const InvoiceInput = z.object({
  buyerGstin: z.string().trim().toUpperCase().regex(GSTIN, "buyer GSTIN is not valid"),
  invoiceNumber: z.string().trim().min(1).max(40),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invoice date must be YYYY-MM-DD"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due date must be YYYY-MM-DD"),
  amount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "amount must be rupees, e.g. 118000.00"),
  irn: z.string().trim().optional(),
  poReference: z.string().trim().optional(),
  file: z.object({ base64: z.string().min(1), mime: z.enum(["application/pdf", "image/png", "image/jpeg"]) }).optional(),
});
export type InvoiceInputT = z.infer<typeof InvoiceInput>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}

/** Raise an invoice for a seller company from structured data. Returns the new invoice, or throws ApiError. */
export async function createSellerInvoice(db: Database, sellerId: string, input: InvoiceInputT, source: "api" | "csv") {
  const [buyer] = await db.select({ id: businesses.id }).from(buyerSellerRelationships).innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId))
    .where(and(eq(buyerSellerRelationships.sellerId, sellerId), eq(businesses.gstin, input.buyerGstin)));
  if (!buyer) throw new ApiError(422, "BUYER_NOT_LINKED", `${input.buyerGstin} is not one of your linked buyers. Add the buyer in the app first.`);

  let contentHash: string, documentRef: string | undefined;
  if (input.file) {
    const doc = await putDocument(Buffer.from(input.file.base64, "base64"), input.file.mime);
    contentHash = doc.hash; documentRef = doc.ref;
  } else {
    // No file was sent (an ERP often has only the data). The hash identifies the invoice by its seller and number.
    contentHash = createHash("sha256").update(`${source}:${sellerId}:${input.invoiceNumber}`).digest("hex");
  }
  try {
    const r = await createInvoice(db, {
      sellerId, buyerId: buyer.id, invoiceNumber: input.invoiceNumber, invoiceDate: input.invoiceDate, dueDate: input.dueDate,
      amount: rupeesToPaise(input.amount), irn: input.irn || undefined, poReference: input.poReference || undefined, contentHash, documentRef,
    });
    await db.update(invoices).set({ source }).where(eq(invoices.id, r.id));
    return r;
  } catch (e) {
    const m = (e as Error).message;
    if (m === "DUPLICATE_INVOICE") {
      const [existing] = await db.select().from(invoices).where(and(eq(invoices.sellerId, sellerId), eq(invoices.invoiceNumber, input.invoiceNumber)));
      throw new ApiError(409, "DUPLICATE_INVOICE", "an invoice with this number, file or e-invoice number already exists", existing ? { invoice: { number: existing.invoiceNumber, status: existing.status } } : undefined);
    }
    if (m.startsWith("INVALID_INVOICE")) throw new ApiError(422, "INVALID_INVOICE", m.replace("INVALID_INVOICE: ", ""));
    throw new ApiError(422, "REJECTED", m);
  }
}

/** The shape outside systems see. Money as rupee strings and exact paise strings, dates as ISO. */
export function publicInvoice(row: { i: typeof invoices.$inferSelect; buyer: string | null; buyerGstin: string | null; seller?: string | null; offer?: typeof financingOffers.$inferSelect | null; paidOutAt?: Date | null; collection?: typeof invoiceCollections.$inferSelect | null }) {
  const { i, offer, collection } = row;
  return {
    number: i.invoiceNumber, status: i.status, source: i.source,
    ...(row.seller !== undefined ? { seller: row.seller } : { buyer: row.buyer, buyerGstin: row.buyerGstin }),
    invoiceDate: i.invoiceDate, dueDate: i.dueDate, amount: toDecimal(i.amount), amountPaise: i.amount.toString(), irnStatus: i.irnStatus, createdAt: i.createdAt.toISOString(),
    offer: offer ? { status: offer.status, advance: toDecimal(offer.advanceAmount), fee: toDecimal(offer.feeAmount), netPayout: toDecimal(offer.advanceAmount - offer.feeAmount), expiresAt: offer.expiresAt.toISOString() } : null,
    financedAt: row.paidOutAt?.toISOString() ?? null,
    outstanding: collection && !collection.closedAt ? { principal: toDecimal(collection.principal), discount: toDecimal(collection.discount), penal: toDecimal(collection.penal) } : null,
    settledAt: collection?.closedAt?.toISOString() ?? null,
  };
}

/** Invoices for a seller company (own invoices) or buyer company (invoices raised on it), newest first, with a simple cursor. */
export async function listInvoices(db: Database, p: { businessId: string; kind: "seller" | "buyer"; status?: string; number?: string; limit?: number; before?: Date }) {
  const mine = p.kind === "seller" ? eq(invoices.sellerId, p.businessId) : eq(invoices.buyerId, p.businessId);
  const other = p.kind === "seller" ? invoices.buyerId : invoices.sellerId;
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const rows = await db.select({ i: invoices, name: businesses.legalName, gstin: businesses.gstin }).from(invoices).innerJoin(businesses, eq(businesses.id, other))
    .where(and(mine, p.status ? eq(invoices.status, p.status as never) : undefined, p.number ? eq(invoices.invoiceNumber, p.number) : undefined, p.before ? lt(invoices.createdAt, p.before) : undefined)).orderBy(desc(invoices.createdAt)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.i.id);
  const [offers, paid, cols] = ids.length ? await Promise.all([
    db.select().from(financingOffers).where(inArray(financingOffers.invoiceId, ids)).orderBy(desc(financingOffers.createdAt)),
    db.select({ inv: financingOffers.invoiceId, at: disbursements.completedAt }).from(disbursements).innerJoin(financingOffers, eq(financingOffers.id, disbursements.offerId)).where(and(inArray(financingOffers.invoiceId, ids), eq(disbursements.status, "succeeded"))),
    db.select().from(invoiceCollections).where(inArray(invoiceCollections.invoiceId, ids)),
  ]) : [[], [], []];
  const items = page.map((r) => publicInvoice({
    i: r.i, buyer: p.kind === "seller" ? r.name : null, buyerGstin: p.kind === "seller" ? r.gstin : null, ...(p.kind === "buyer" ? { seller: r.name } : {}),
    offer: p.kind === "seller" ? offers.find((o) => o.invoiceId === r.i.id) ?? null : null, paidOutAt: paid.find((x) => x.inv === r.i.id)?.at ?? null, collection: cols.find((c) => c.invoiceId === r.i.id) ?? null,
  }));
  return { items, nextBefore: rows.length > limit ? page[page.length - 1].i.createdAt.toISOString() : null };
}
