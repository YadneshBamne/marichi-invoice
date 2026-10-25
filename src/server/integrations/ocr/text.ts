// Getting text out of an invoice file with open-source tools only.
//  - A digital PDF already has its text: read it with pdf.js (unpdf), keeping the layout by rebuilding lines from positions.
//  - A scan or a photo has none: read the pixels with Tesseract (tesseract.js, English data shipped in node_modules, no network).
//  - A PDF that turns out to be a scan is drawn to an image first, then read the same way.
import path from "node:path";
import { getDocumentProxy, extractTextItems, renderPageAsImage } from "unpdf";

/** Rebuild lines from positioned fragments: same row = same line, left to right, wide gaps kept as column breaks. */
export function linesFromItems(items: { str: string; x: number; y: number; width: number; fontSize: number }[]): string {
  const rows: { y: number; parts: typeof items }[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const tol = Math.max(2, it.fontSize * 0.45);
    const row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
    if (row) row.parts.push(it); else rows.push({ y: it.y, parts: [it] });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => {
    const parts = r.parts.sort((a, b) => a.x - b.x);
    let line = "";
    parts.forEach((p, i) => {
      if (i === 0) { line = p.str.trim(); return; }
      const prev = parts[i - 1];
      const gap = p.x - (prev.x + prev.width);
      line += (gap > p.fontSize * 1.5 ? "   " : " ") + p.str.trim();
    });
    return line;
  }).join("\n");
}

const MAX_PAGES = 4; // an invoice is one to three pages; the total is on the last

export async function pdfText(bytes: Uint8Array): Promise<{ text: string; scanned: boolean }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { items, totalPages } = await extractTextItems(pdf);
  const take = Math.min(totalPages, MAX_PAGES);
  const pages = items.slice(0, take).map((p) => linesFromItems(p));
  const text = pages.join("\n");
  if (text.replace(/\s/g, "").length >= 40) return { text, scanned: false };
  // No text layer: it is a scan. Draw the pages and read them like photos.
  const out: string[] = [];
  for (let n = 1; n <= take; n++) {
    const png = await renderPageAsImage(pdf, n, { canvasImport: () => import("@napi-rs/canvas"), scale: 2 });
    out.push(await imageText(new Uint8Array(png)));
  }
  return { text: out.join("\n"), scanned: true };
}

// One Tesseract worker is reused between requests (starting one costs a second or two) and let go when idle.
type Worker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;
let shared: Promise<Worker> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve(); // one page at a time per worker

async function worker(): Promise<Worker> {
  if (!shared) {
    shared = (async () => {
      const { createWorker } = await import("tesseract.js");
      const langPath = path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
      return createWorker("eng", 1, { langPath, cachePath: path.join(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "tesseract-cache"), gzip: true });
    })().catch((e) => { shared = null; throw e; });
  }
  return shared;
}

export async function imageText(bytes: Uint8Array): Promise<string> {
  const run = async () => {
    const w = await worker();
    if (idle) clearTimeout(idle);
    try {
      const { data } = await w.recognize(Buffer.from(bytes));
      return data.text;
    } finally {
      idle = setTimeout(() => { const s = shared; shared = null; s?.then((x) => x.terminate()).catch(() => {}); }, 60_000);
      idle.unref?.();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
