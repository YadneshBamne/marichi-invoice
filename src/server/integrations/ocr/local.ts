// Free, open-source invoice reading: pdf.js and Tesseract for the text, rules for the fields, an optional local or free model as a second opinion.
// No account, no key and no per-document cost. Used when no paid reader is configured.
import type { OcrPort } from "../gateway";
import { imageText, pdfText } from "./text";
import { parseInvoice } from "./parse";
import { refine, llmFromEnv, type Llm } from "./llm";
import { market } from "../../../lib/countries";

const IMAGES = new Set(["image/png", "image/jpeg"]);

export function localOcr(opts: { llm?: Llm | null } = {}): OcrPort {
  return {
    async extractInvoice({ bytes, mime }) {
      let text: string;
      let scanned = false;
      if (mime === "application/pdf") ({ text, scanned } = await pdfText(bytes));
      else if (IMAGES.has(mime)) { text = await imageText(bytes); scanned = true; }
      else throw new Error("only PDF, PNG or JPEG invoices can be read");
      if (text.replace(/\s/g, "").length < 20) throw new Error("no readable text was found. Try a clearer photo or the original PDF, or type the values in");

      let parsed = parseInvoice(text);
      const llm = opts.llm === undefined ? llmFromEnv() : opts.llm;
      if (llm) { try { parsed = await refine(text, parsed, llm); } catch (e) { parsed.warnings.push(`The optional reading helper was not available (${(e as Error).message}). The rules reading is shown.`); } }
      if (!parsed.fields.currency) parsed.fields.currency = market().currency.code;
      if (scanned) parsed.warnings.unshift("This was read from a picture, so a digit may be wrong. Check every value.");
      return { fields: parsed.fields, simulated: false, warnings: parsed.warnings };
    },
  };
}
