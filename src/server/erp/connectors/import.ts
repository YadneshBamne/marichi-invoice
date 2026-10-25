// Turns rows pulled from an accounting system (Tally, Zoho Books, QuickBooks) into invoices, through the same checks as the CSV import:
// buyer must be a linked buyer, duplicates are refused, the e-invoice and fraud checks run. Each row gets its own plain-language result.
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { businesses, buyerSellerRelationships, invoices } from "../../db/schema";
import { MAX_ROWS, type RowResult } from "../csv";
import { ApiError, createSellerInvoice, InvoiceInput } from "../invoices";
import { toDecimal } from "../../../lib/money";
import { market } from "../../../lib/countries";
import type { ErpInvoiceRow } from "./types";

export async function importErpRows(db: Database, sellerId: string, rows: ErpInvoiceRow[], opts: { dryRun?: boolean } = {}) {
  if (!rows.length) throw new ApiError(422, "EMPTY_FILE", "no invoices were found to import");
  if (rows.length > MAX_ROWS) throw new ApiError(422, "TOO_MANY_ROWS", `import at most ${MAX_ROWS} invoices at a time`);
  const linked = new Set((await db.select({ g: businesses.gstin }).from(buyerSellerRelationships).innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId)).where(eq(buyerSellerRelationships.sellerId, sellerId))).map((x) => x.g));
  const existing = new Set((await db.select({ n: invoices.invoiceNumber }).from(invoices).where(and(eq(invoices.sellerId, sellerId)))).map((x) => x.n));
  const results: RowResult[] = [], seen = new Set<string>(), code = market().currency.code;
  for (const [i, r] of rows.entries()) {
    const line = i + 1, number = r.invoiceNumber;
    try {
      if (seen.has(number)) throw new ApiError(422, "REPEATED", "this invoice number appears twice");
      seen.add(number);
      if (r.currency.toUpperCase() !== code) throw new ApiError(422, "CURRENCY", `this invoice is in ${r.currency}; only ${code} invoices can be imported here`);
      if (!r.buyerTaxId) throw new ApiError(422, "NO_BUYER_ID", `${r.buyerName} has no ${market().ids.taxReg.label} in your accounting system; add it there and import again`);
      if (!r.dueDate) throw new ApiError(422, "NO_DUE_DATE", "there is no due date or credit period on this invoice");
      const parsed = InvoiceInput.safeParse({ buyerGstin: r.buyerTaxId, invoiceNumber: number, invoiceDate: r.invoiceDate, dueDate: r.dueDate, amount: toDecimal(r.amountMinor), poReference: r.poReference ?? undefined });
      if (!parsed.success) throw new ApiError(422, "INVALID", parsed.error.issues[0].message);
      if (opts.dryRun) {
        if (!linked.has(parsed.data.buyerGstin)) throw new ApiError(422, "BUYER_NOT_LINKED", `${r.buyerName} (${parsed.data.buyerGstin}) is not one of your linked buyers. Add the buyer in the app first.`);
        if (existing.has(number)) throw new ApiError(409, "DUPLICATE_INVOICE", "an invoice with this number already exists");
        results.push({ line, number, ok: true });
        continue;
      }
      const made = await createSellerInvoice(db, sellerId, parsed.data, "erp");
      results.push({ line, number, ok: true, id: made.id });
    } catch (e) {
      results.push({ line, number, ok: false, error: (e as Error).message });
    }
  }
  return { results, imported: opts.dryRun ? 0 : results.filter((x) => x.ok).length, valid: results.filter((x) => x.ok).length, invalid: results.filter((x) => !x.ok).length };
}
