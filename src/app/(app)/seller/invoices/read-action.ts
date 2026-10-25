"use server";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { businesses, buyerSellerRelationships } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { assertCan } from "@/server/permissions";
import { gateway } from "@/server/integrations/gateway";
import { MAX_DOC_BYTES } from "@/server/vault";
import { market } from "@/lib/countries";

export type Reading =
  | { ok: true; simulated: boolean; values: { invoiceNumber?: string; invoiceDate?: string; dueDate?: string; amount?: string; irn?: string; poReference?: string; buyerId?: string }; found: string[]; notes: string[] }
  | { ok: false; error: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

/** Read an uploaded invoice and suggest values for the form. Suggestions only: nothing is saved here. */
export async function readInvoice(fd: FormData): Promise<Reading> {
  const u = await requireUser(["seller"]);
  try {
    assertCan(u, "invoice.upload");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file first." };
    if (file.size > MAX_DOC_BYTES) return { ok: false, error: "The file is over 4 MB." };
    const { fields: f, simulated, warnings } = await gateway.ocr.extractInvoice({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type });

    const values: Extract<Reading, { ok: true }>["values"] = {};
    const notes: string[] = [...(warnings ?? [])];
    if (f.invoiceNumber) values.invoiceNumber = f.invoiceNumber.trim().slice(0, 40);
    if (f.invoiceDate && ISO.test(f.invoiceDate)) values.invoiceDate = f.invoiceDate;
    if (f.dueDate && ISO.test(f.dueDate)) values.dueDate = f.dueDate;
    const amount = f.totalAmount?.replace(/,/g, "");
    if (amount && AMOUNT.test(amount)) values.amount = amount;
    if (f.irn && /^[0-9a-f]{64}$/i.test(f.irn.trim())) values.irn = f.irn.trim();
    if (f.poReference) values.poReference = f.poReference.trim();
    const home = market().currency;
    if (f.currency && f.currency.toUpperCase() !== home.code) notes.push(`The invoice looks to be in ${f.currency.toUpperCase()}. Only ${home.major} invoices can be financed here, so check the amount.`);

    // Match the buyer by GSTIN against the buyers already linked to this seller; never create or guess one.
    if (f.buyerGstin && u.businessId) {
      const linked = await db.select({ id: businesses.id, gstin: businesses.gstin }).from(buyerSellerRelationships)
        .innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId)).where(eq(buyerSellerRelationships.sellerId, u.businessId));
      const hit = linked.find((b) => b.gstin?.toUpperCase() === f.buyerGstin!.trim().toUpperCase());
      if (hit) values.buyerId = hit.id;
      else notes.push(`The buyer on the invoice (${f.buyerName ?? f.buyerGstin}) is not one of your linked buyers. Add them under Buyers first.`);
    }
    return { ok: true, simulated, values, found: Object.keys(values), notes };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The invoice could not be read." };
  }
}
