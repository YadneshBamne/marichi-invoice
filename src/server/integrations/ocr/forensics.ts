// Doubts about an uploaded PDF that come from HOW it was made, not from what it says: the tool that wrote it, when, whether it was
// edited afterwards, whether it looks like the seller's other invoices. None of these proves anything. Each is a signal that adds to a
// score, and a person decides (see fraud/engine.ts). A file we cannot inspect simply has no signals.
import { getDocumentProxy, getMeta } from "unpdf";

export type Fingerprint = {
  producer: string | null; creator: string | null; created: string | null; modified: string | null;
  pages: number; textLayer: boolean;
};
export type DocSignal = { rule: string; label: string; severity: "low" | "medium" | "high"; score: number; detail: Record<string, unknown> };

const EDITORS = /ilovepdf|smallpdf|sejda|pdfescape|pdf24|pdfsam|pdfcandy|photoshop|gimp|canva|inkscape|nitro|phantompdf|foxit.*edit|pdf-?xchange.*edit|online2pdf|docfly/i;

export async function fingerprint(bytes: Uint8Array): Promise<Fingerprint | null> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { info } = await getMeta(pdf, { parseDates: true });
    const page = await pdf.getPage(1);
    const text = await page.getTextContent();
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const d = (v: unknown) => { const t = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null; return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null; };
    return { producer: s(info?.Producer), creator: s(info?.Creator), created: d(info?.CreationDate), modified: d(info?.ModDate), pages: pdf.numPages, textLayer: text.items.some((i) => "str" in i && (i as { str: string }).str.trim().length > 0) };
  } catch { return null; } // not a PDF, or damaged: nothing to say
}

const day = (iso: string) => Date.parse(iso.slice(0, 10));
const DAY = 86_400_000;

/**
 * @param fp this file
 * @param ctx the date printed on the invoice, today, and fingerprints of the seller's earlier invoices
 */
export function forensicSignals(fp: Fingerprint | null, ctx: { invoiceDate?: string; now: Date; history: Fingerprint[] }): DocSignal[] {
  if (!fp) return [];
  const out: DocSignal[] = [];
  const tool = `${fp.producer ?? ""} ${fp.creator ?? ""}`;
  if (EDITORS.test(tool)) out.push({ rule: "document_editor", label: "The file was made or changed with a PDF or image editor", severity: "medium", score: 20, detail: { producer: fp.producer, creator: fp.creator } });
  if (fp.created && fp.modified && day(fp.modified) - day(fp.created) > DAY && fp.producer && fp.creator && fp.producer.toLowerCase() !== fp.creator.toLowerCase())
    out.push({ rule: "modified_after_creation", label: "The file was changed by a different program after it was made", severity: "medium", score: 15, detail: { created: fp.created, modified: fp.modified, creator: fp.creator, producer: fp.producer } });
  if (fp.created && ctx.invoiceDate && day(ctx.invoiceDate) - day(fp.created) > DAY)
    out.push({ rule: "created_before_invoice_date", label: "The file was created before the date it carries", severity: "medium", score: 25, detail: { created: fp.created, invoiceDate: ctx.invoiceDate } });
  if (fp.created && Date.parse(fp.created) - ctx.now.getTime() > DAY)
    out.push({ rule: "created_in_future", label: "The file claims to have been created in the future", severity: "medium", score: 20, detail: { created: fp.created } });
  // Against the seller's own habit: three or more earlier files give something to compare with
  if (ctx.history.length >= 3) {
    const lower = (s: string | null) => (s ?? "").toLowerCase();
    const tools = new Set(ctx.history.flatMap((h) => [lower(h.producer), lower(h.creator)]).filter(Boolean));
    if ((fp.producer || fp.creator) && !tools.has(lower(fp.producer)) && !tools.has(lower(fp.creator)))
      out.push({ rule: "template_change", label: "This file comes from a different program than the seller's earlier invoices", severity: "low", score: 10, detail: { now: tool.trim(), before: [...tools].slice(0, 4) } });
    if (!fp.textLayer && ctx.history.every((h) => h.textLayer))
      out.push({ rule: "scan_instead_of_digital", label: "A picture of an invoice, where the seller's earlier ones were digital files", severity: "low", score: 10, detail: {} });
  }
  return out;
}
