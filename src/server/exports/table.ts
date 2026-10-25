// One table model, three downloads. Reports build a Table; CSV, Excel and PDF are just ways of drawing it, so every report gets all three.
// The Excel file is written by hand (a zip of a few XML parts) and the PDF with pdf-lib, which the platform already uses for agreements.
import { deflateRawSync } from "node:zlib";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { toCsv } from "../ledger/reports";

export type Cell = string | number | bigint | null;
/** `note` is a line that must travel with the data (for example "DRAFT, not filed"); it is printed on the PDF and as the first line of the Excel file. */
export type Table = { title: string; head: string[]; rows: Cell[][]; note?: string };
export const FORMATS = { csv: { type: "text/csv; charset=utf-8", ext: "csv" }, xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" }, pdf: { type: "application/pdf", ext: "pdf" } } as const;
export type Format = keyof typeof FORMATS;

const text = (c: Cell) => (c === null ? "" : String(c));
/** CSV is for machines, so its column names are the headings in lower case with underscores ("Repaid %" becomes "repaid"). */
const snake = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
export const tableCsv = (t: Table) => toCsv([...(t.note ? [[t.note], []] : []), t.head.map(snake), ...t.rows.map((r) => r.map((c) => c ?? ""))]);

// ---- Excel ----
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// A string is stored as a number only when that cannot change it: no leading zero, at most 15 digits (Excel's limit), so ids and account numbers stay text.
const NUM = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
const isNumber = (c: Cell) => typeof c === "number" ? Number.isFinite(c) : typeof c === "bigint" ? c <= BigInt(Number.MAX_SAFE_INTEGER) && c >= -BigInt(Number.MAX_SAFE_INTEGER) : typeof c === "string" && NUM.test(c) && c.replace(/\D/g, "").length <= 15;

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A zip file holding the given parts, each deflated. */
export function zip(files: { name: string; data: Buffer }[], now = new Date()) {
  const time = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  const date = (Math.max(1980, now.getUTCFullYear()) - 1980) << 9 | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), body = deflateRawSync(f.data), crc = crc32(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(h, name, body); central.push(c, name);
    offset += h.length + name.length + body.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;
const R = `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xml = (body: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`);

export function tableXlsx(t: Table, now = new Date()) {
  const lead = t.note ? 2 : 0; // the note and a blank line before the header
  const cell = (c: Cell, r: number, col: number, s = 0) => {
    const ref = `${colName(col)}${r}`, st = s ? ` s="${s}"` : "";
    return c === null || c === "" ? "" : isNumber(c) ? `<c r="${ref}"${st}><v>${c}</v></c>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(text(c))}</t></is></c>`;
  };
  const row = (cells: Cell[], r: number, s = 0) => `<row r="${r}">${cells.map((c, i) => cell(c, r, i, s)).join("")}</row>`;
  const widths = t.head.map((h, i) => Math.min(60, Math.max(10, h.length + 2, ...t.rows.slice(0, 500).map((r) => text(r[i]).length + 2))));
  const sheet = `<worksheet ${NS}><sheetViews><sheetView workbookViewId="0"><pane ySplit="${lead + 1}" topLeftCell="A${lead + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>`
    + (t.note ? row([t.note], 1, 1) : "") + row(t.head, lead + 1, 1) + t.rows.map((r, i) => row(r, lead + 2 + i)).join("") + `</sheetData></worksheet>`;
  const name = esc(t.title.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet1");
  return zip([
    { name: "[Content_Types].xml", data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: "_rels/.rels", data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: xml(`<workbook ${NS} ${R}><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/styles.xml", data: xml(`<styleSheet ${NS}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`) },
    { name: "xl/worksheets/sheet1.xml", data: xml(sheet) },
  ], now);
}

// ---- PDF ----
const PAGE: [number, number] = [841.89, 595.28], M = 36, SIZE = 8, LINE = 13;

/** The standard PDF font cannot draw every character (the rupee sign, non-Latin names); those become "?" instead of failing the whole file. */
function fit(font: PDFFont) {
  const ok = new Map<string, boolean>();
  const safe = (s: string) => [...s.normalize("NFC").replace(/₹/g, "Rs ").replace(/[\r\n\t]+/g, " ")].map((ch) => {
    let g = ok.get(ch);
    if (g === undefined) { try { font.encodeText(ch); g = true; } catch { g = false; } ok.set(ch, g); }
    return g ? ch : "?";
  }).join("");
  return safe;
}

export async function tablePdf(t: Table, now = new Date()) {
  const doc = await PDFDocument.create();
  doc.setTitle(t.title); doc.setCreator("Marichi Labs"); doc.setCreationDate(now);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = fit(font), w = (s: string, f = font) => f.widthOfTextAtSize(s, SIZE);
  const head = t.head.map(safe), rows = t.rows.map((r) => r.map((c) => safe(text(c))));
  const avail = PAGE[0] - 2 * M;
  const natural = head.map((h, i) => Math.min(190, Math.max(w(h, bold), ...rows.slice(0, 300).map((r) => w(r[i]))) + 10));
  const scale = Math.min(1.5, avail / natural.reduce((a, b) => a + b, 0)); // narrow tables spread out a little, wide ones shrink to fit
  const cols = natural.map((x) => x * scale);
  const clip = (s: string, width: number, f = font) => { if (w(s, f) <= width - 6) return s; let k = s.length; while (k > 1 && w(s.slice(0, k) + "...", f) > width - 6) k--; return s.slice(0, k) + "..."; };
  const x0 = (i: number) => M + cols.slice(0, i).reduce((a, b) => a + b, 0);
  const num = (s: string) => NUM.test(s.replace(/,/g, ""));

  const firstTop = PAGE[1] - M - (t.note ? 56 : 40), otherTop = PAGE[1] - M - 8, bottom = M + 14;
  const perFirst = Math.max(1, Math.floor((firstTop - bottom) / LINE) - 1), perOther = Math.max(1, Math.floor((otherTop - bottom) / LINE) - 1);
  const chunks: string[][][] = [];
  for (let i = 0, n = perFirst; i < rows.length || chunks.length === 0; i += n, n = perOther) chunks.push(rows.slice(i, i + n));

  chunks.forEach((chunk, p) => {
    const page = doc.addPage(PAGE);
    let y = PAGE[1] - M;
    if (p === 0) {
      page.drawText(safe(t.title), { x: M, y: y - 14, size: 14, font: bold });
      page.drawText(`Generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC  |  ${rows.length} row${rows.length === 1 ? "" : "s"}`, { x: M, y: y - 28, size: SIZE, font, color: rgb(0.4, 0.4, 0.4) });
      if (t.note) page.drawText(clip(safe(t.note), avail, bold), { x: M, y: y - 42, size: SIZE, font: bold, color: rgb(0.7, 0.1, 0.1) });
      y = firstTop;
    } else y = otherTop;
    const tw = cols.reduce((a, b) => a + b, 0);
    page.drawRectangle({ x: M, y: y - LINE + 3, width: tw, height: LINE, color: rgb(0.92, 0.93, 0.95) });
    head.forEach((h, i) => page.drawText(clip(h, cols[i], bold), { x: x0(i) + 3, y: y - LINE + 6, size: SIZE, font: bold }));
    y -= LINE;
    chunk.forEach((r, k) => {
      y -= LINE;
      if (k % 2) page.drawRectangle({ x: M, y: y + 3 - 0.5, width: tw, height: LINE, color: rgb(0.97, 0.97, 0.98) });
      r.forEach((c, i) => { const s = clip(c, cols[i]); page.drawText(s, { x: num(c) ? x0(i) + cols[i] - 3 - w(s) : x0(i) + 3, y: y + 6, size: SIZE, font }); });
    });
    const foot = `Page ${p + 1} of ${chunks.length}`;
    page.drawText(foot, { x: PAGE[0] - M - w(foot), y: M - 4, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
  });
  return doc.save();
}

/** The file to send for a download: format from the query (csv when absent or unknown), name without extension. */
export async function tableResponse(t: Table, format: string | null | undefined, name: string, now = new Date()) {
  const f: Format = format === "xlsx" || format === "pdf" ? format : "csv";
  const body = f === "xlsx" ? tableXlsx(t, now) : f === "pdf" ? await tablePdf(t, now) : tableCsv(t);
  return new Response(body as BodyInit, { headers: { "content-type": FORMATS[f].type, "content-disposition": `attachment; filename="${name}.${FORMATS[f].ext}"`, "cache-control": "private, no-store" } });
}
