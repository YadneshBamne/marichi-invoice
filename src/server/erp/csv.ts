// CSV import for invoices, shaped for the exports accounting tools produce (Tally, Zoho Books, Excel). Forgiving about
// headers, date styles and rupee formatting; strict about everything that matters. A dry run checks without saving.
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { parseCsv } from "../util/csv";
import { businesses, buyerSellerRelationships, invoices } from "../db/schema";
import { ApiError, createSellerInvoice, InvoiceInput } from "./invoices";

export const MAX_ROWS = 200;

export { parseCsv };

const ALIASES: Record<string, string> = {
  invoice_number: "invoiceNumber", invoice_no: "invoiceNumber", invoice: "invoiceNumber", number: "invoiceNumber", bill_no: "invoiceNumber",
  buyer_gstin: "buyerGstin", gstin: "buyerGstin", customer_gstin: "buyerGstin", party_gstin: "buyerGstin",
  invoice_date: "invoiceDate", date: "invoiceDate", due_date: "dueDate", due: "dueDate",
  amount: "amount", total: "amount", grand_total: "amount", invoice_amount: "amount", total_amount: "amount",
  irn: "irn", po_reference: "poReference", po: "poReference", po_number: "poReference",
};
const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** DD-MM-YYYY, DD/MM/YYYY and YYYY-MM-DD to YYYY-MM-DD (or null). */
export function isoDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let [y, mo, d] = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  if (!m && (m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [y, mo, d] = [+m[3], +m[2], +m[1]];
  if (!y) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}
const rupees = (s: string) => s.replace(/(?:₹|rs\.?|inr)/gi, "").replace(/[,\s]/g, "");

export type RowResult = { line: number; number: string; ok: boolean; error?: string; id?: string };

export async function importInvoices(db: Database, sellerId: string, text: string, opts: { dryRun?: boolean } = {}) {
  const table = parseCsv(text);
  if (table.length < 2) throw new ApiError(422, "EMPTY_FILE", "the file needs a header row and at least one invoice");
  if (table.length - 1 > MAX_ROWS) throw new ApiError(422, "TOO_MANY_ROWS", `import at most ${MAX_ROWS} invoices at a time`);
  const cols = table[0].map((h) => ALIASES[norm(h)] ?? null);
  const need = ["invoiceNumber", "buyerGstin", "invoiceDate", "dueDate", "amount"];
  const missing = need.filter((k) => !cols.includes(k));
  if (missing.length) throw new ApiError(422, "MISSING_COLUMNS", `the file is missing a column for: ${missing.join(", ")}`);

  // A dry run must tell the truth about the real import, so it checks the same two things the real one would hit.
  const linked = new Set((await db.select({ g: businesses.gstin }).from(buyerSellerRelationships).innerJoin(businesses, eq(businesses.id, buyerSellerRelationships.buyerId)).where(eq(buyerSellerRelationships.sellerId, sellerId))).map((x) => (x.g ?? "").toUpperCase()));
  const existing = new Set((await db.select({ n: invoices.invoiceNumber }).from(invoices).where(and(eq(invoices.sellerId, sellerId)))).map((x) => x.n));
  const results: RowResult[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < table.length; r++) {
    const rec: Record<string, string> = {};
    cols.forEach((c, i) => { if (c) rec[c] = (table[r][i] ?? "").trim(); });
    const line = r + 1, number = rec.invoiceNumber ?? "";
    try {
      if (seen.has(number)) throw new ApiError(422, "REPEATED_IN_FILE", "this invoice number appears twice in the file");
      seen.add(number);
      const invoiceDate = isoDate(rec.invoiceDate ?? ""), dueDate = isoDate(rec.dueDate ?? "");
      if (!invoiceDate) throw new ApiError(422, "BAD_DATE", `invoice date "${rec.invoiceDate}" is not a date (use DD-MM-YYYY or YYYY-MM-DD)`);
      if (!dueDate) throw new ApiError(422, "BAD_DATE", `due date "${rec.dueDate}" is not a date (use DD-MM-YYYY or YYYY-MM-DD)`);
      const parsed = InvoiceInput.safeParse({ buyerGstin: rec.buyerGstin, invoiceNumber: number, invoiceDate, dueDate, amount: rupees(rec.amount ?? ""), irn: rec.irn || undefined, poReference: rec.poReference || undefined });
      if (!parsed.success) throw new ApiError(422, "INVALID", parsed.error.issues[0].message);
      if (opts.dryRun) {
        if (!linked.has(parsed.data.buyerGstin)) throw new ApiError(422, "BUYER_NOT_LINKED", `${parsed.data.buyerGstin} is not one of your linked buyers. Add the buyer in the app first.`);
        if (existing.has(number)) throw new ApiError(409, "DUPLICATE_INVOICE", "an invoice with this number already exists");
        results.push({ line, number, ok: true });
        continue;
      }
      const made = await createSellerInvoice(db, sellerId, parsed.data, "csv");
      results.push({ line, number, ok: true, id: made.id });
    } catch (e) {
      results.push({ line, number, ok: false, error: e instanceof ApiError ? e.message : (e as Error).message });
    }
  }
  return { results, imported: opts.dryRun ? 0 : results.filter((x) => x.ok).length, valid: results.filter((x) => x.ok).length, invalid: results.filter((x) => !x.ok).length };
}
