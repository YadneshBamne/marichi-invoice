// Renders a structured Doc (templates.ts) to a PDF with pdf-lib: pure JavaScript, no browser, works on Vercel.
// Uses the built-in Times fonts, which only cover Latin-1. Text is sanitised to that range (the rupee sign becomes "Rs.");
// legal names in Indian company and GST records are in English script. Swap in an embedded Unicode font if that changes.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Doc, Run } from "./templates";

const W = 595.28, H = 841.89, M = 56, BODY = 11, LEAD = 16;
const INK = rgb(0.08, 0.1, 0.09), RED = rgb(0.7, 0.1, 0.1), GREY = rgb(0.4, 0.42, 0.41);

/** Make text safe for WinAnsi fonts: known symbols mapped, anything else outside Latin-1 becomes "?". */
export function pdfSafe(s: string): string {
  return s
    .replace(/₹\s?/g, "Rs. ")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/ /g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E¡-ÿ]/g, "?");
}

type Word = { t: string; bold: boolean };
const words = (runs: Run[]): Word[] => runs.flatMap((r) => {
  const bold = typeof r !== "string";
  return pdfSafe(typeof r === "string" ? r : r.b).split(/(\s+)/).filter((x) => x.length > 0).map((t) => ({ t, bold }));
});

export async function renderPdf(d: Doc, meta: { footer?: string } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(d.title)); pdf.setCreator("Marichi Labs"); pdf.setProducer("Marichi Labs");
  const reg = await pdf.embedFont(StandardFonts.TimesRoman), bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const pages: PDFPage[] = [];
  let page!: PDFPage, y = 0;
  const newPage = () => { page = pdf.addPage([W, H]); pages.push(page); y = H - M; };
  const need = (h: number) => { if (y - h < M + 20) newPage(); };
  const font = (b: boolean): PDFFont => (b ? bold : reg);

  // Lay out words into lines no wider than `width`, then draw them starting at x.
  const flow = (ws: Word[], x: number, width: number, size = BODY) => {
    const lines: Word[][] = [[]]; let used = 0;
    for (const w of ws) {
      const wd = font(w.bold).widthOfTextAtSize(w.t, size);
      const space = /^\s+$/.test(w.t);
      if (used + wd > width && !space && lines.at(-1)!.length) { lines.push([]); used = 0; }
      if (space && !lines.at(-1)!.length) continue; // no leading spaces on a line
      lines.at(-1)!.push(w); used += wd;
    }
    for (const line of lines) {
      need(LEAD);
      let cx = x;
      for (const w of line) { page.drawText(w.t, { x: cx, y: y - size, size, font: font(w.bold), color: INK }); cx += font(w.bold).widthOfTextAtSize(w.t, size); }
      y -= LEAD;
    }
  };

  newPage();
  page.drawText("DRAFT TEMPLATE: pending legal review", { x: M, y: y - 10, size: 9, font: bold, color: RED });
  y -= 30;

  for (const b of d.blocks) {
    if ("h" in b) {
      need(40); y -= 6;
      page.drawText(pdfSafe(b.h), { x: M, y: y - 18, size: 18, font: bold, color: INK });
      y -= 34;
    } else if ("p" in b) {
      flow(words(b.p), M, W - 2 * M); y -= 6;
    } else if ("ol" in b) {
      b.ol.forEach((item, i) => {
        need(LEAD);
        page.drawText(`${i + 1}.`, { x: M, y: y - BODY, size: BODY, font: reg, color: INK });
        flow(words(item), M + 24, W - 2 * M - 24); y -= 4;
      });
      y -= 4;
    } else {
      const col = 190;
      for (const [k, v] of b.table) {
        const start = y;
        need(LEAD * 2);
        const top = y;
        flow(words([{ b: k }]), M, col - 12);
        const afterKey = y;
        y = top;
        flow(words([v]), M + col, W - 2 * M - col);
        y = Math.min(y, afterKey) - 4;
        page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.4, color: rgb(0.85, 0.87, 0.86) });
        void start;
      }
      y -= 8;
    }
  }

  const total = pages.length;
  pages.forEach((p, i) => p.drawText(pdfSafe(`${meta.footer ?? "Marichi Labs"}   Page ${i + 1} of ${total}`), { x: M, y: 28, size: 8, font: reg, color: GREY }));
  return pdf.save();
}
