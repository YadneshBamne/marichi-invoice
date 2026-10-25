// Reading a bank statement the seller downloaded from net banking: a CSV, or a PDF that has a text layer (not a photo or a scan).
// Both end up as rows of cells, and one piece of row logic turns them into lines. Amounts are integer paise (bigint), never floats.
import { extractTextItems, getDocumentProxy } from "unpdf";

export type StatementLine = { on: string; narration: string; debit: bigint; credit: bigint; balance: bigint | null };
export type ParsedStatement = { lines: StatementLine[]; bankName: string | null; accountLast4: string | null; periodFrom: string; periodTo: string };
/** A problem with the file itself. The message is written for the seller. */
export class StatementError extends Error {}

export const MIN_ROWS = 3;
export const MAX_ROWS = 20_000;
const MAX_PAGES = 80;
const NO_TABLE = "We could not find the list of transactions in this file. It needs a row of headings such as Date, Narration, Withdrawal, Deposit and Balance. Download the statement as CSV from your net banking and upload that.";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------- numbers and dates ----------

/** "1,23,456.78", "₹ 500.00 Dr", "(250.00)", "-1200" -> paise, plus a Dr/Cr marker or minus sign if there was one. */
export function parseAmount(raw: string | undefined): { v: bigint; dir: "dr" | "cr" | null; neg: boolean } | null {
  if (!raw) return null;
  let s = raw.toUpperCase().replace(/₹|RS\.?|INR/g, "").replace(/\s+/g, "");
  let dir: "dr" | "cr" | null = null, neg = false;
  const mark = /^(DR|CR)\.?|(DR|CR)\.?$/.exec(s);
  if (mark) { dir = (mark[1] ?? mark[2]) === "DR" ? "dr" : "cr"; s = s.replace(mark[0], ""); }
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s[0] === "-") { neg = true; s = s.slice(1); } else if (s[0] === "+") s = s.slice(1);
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s.replace(/,/g, ""));
  if (!m || !(m[1] || m[2])) return null;
  return { v: BigInt(m[1] || "0") * 100n + BigInt((m[2] ?? "").slice(0, 2).padEnd(2, "0") || "0"), dir, neg };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** dd/mm/yy, dd/mm/yyyy, dd-MMM-yyyy, dd MMM yy, yyyy-mm-dd -> "yyyy-mm-dd", or null when it is not a real date. */
export function parseDate(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  let y: number, mo: number, d: number, m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]+(\d{4}|\d{2})\b/.exec(t))) [y, mo, d] = [+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(t))) [y, mo, d] = [+m[3], +m[2], +m[1]];
  else return null;
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// ---------- the table ----------

type Cols = { date: number; narr: number; debit: number; credit: number; balance: number; amount: number; type: number };

/** Does this row look like the heading row of a transaction table? If so, which column is which. */
function headerCols(cells: string[]): Cols | null {
  const c: Cols = { date: -1, narr: -1, debit: -1, credit: -1, balance: -1, amount: -1, type: -1 };
  let valueDate = -1;
  const put = (k: keyof Cols, i: number) => { if (c[k] < 0) c[k] = i; };
  cells.forEach((raw, i) => {
    const h = norm(raw);
    if (!h) return;
    if (/^(dr cr|cr dr|dr or cr|debit credit|credit debit|type|txn type|transaction type|dr cr indicator|cr dr indicator)$/.test(h)) put("type", i);
    else if (/\bbalance\b|^bal\b/.test(h)) put("balance", i);
    else if (/^(withdrawals?|debits?|dr|paid out|money out)\b/.test(h)) put("debit", i);
    else if (/^(deposits?|credits?|cr|paid in|money in)\b/.test(h)) put("credit", i);
    else if (/\bdate\b|\bdt\b/.test(h)) { if (/value|\bval\b/.test(h)) { if (valueDate < 0) valueDate = i; } else put("date", i); }
    else if (/narration|description|particulars|remarks|details/.test(h)) put("narr", i);
    else if (/\bamount\b|^amt\b/.test(h)) put("amount", i);
  });
  if (c.date < 0) c.date = valueDate;
  const money = (c.debit >= 0 && c.credit >= 0) || c.amount >= 0;
  return c.date >= 0 && c.narr >= 0 && money ? c : null;
}

const typeDir = (s: string | undefined): "dr" | "cr" | null => {
  const t = norm(s ?? "");
  return /^(dr|debit|d|wd|withdrawal)\b/.test(t) ? "dr" : /^(cr|credit|c|deposit)\b/.test(t) ? "cr" : null;
};
const BANKS: [RegExp, string][] = [
  [/hdfc/i, "HDFC Bank"], [/icici/i, "ICICI Bank"], [/state bank|\bsbi\b|sbin/i, "State Bank of India"], [/axis bank|utib/i, "Axis Bank"], [/kotak|kkbk/i, "Kotak Mahindra Bank"],
  [/yes bank|yesb/i, "Yes Bank"], [/idfc|idfb/i, "IDFC First Bank"], [/indusind|indb/i, "IndusInd Bank"], [/punjab national|punb/i, "Punjab National Bank"], [/bank of baroda|barb/i, "Bank of Baroda"],
  [/canara|cnrb/i, "Canara Bank"], [/union bank|ubin/i, "Union Bank of India"], [/central bank|cbin/i, "Central Bank of India"], [/bank of india|bkid/i, "Bank of India"], [/federal bank|fdrl/i, "Federal Bank"], [/\brbl\b|ratn/i, "RBL Bank"],
  [/bandhan|bdbl/i, "Bandhan Bank"], [/indian bank|idib/i, "Indian Bank"], [/\buco\b|ucba/i, "UCO Bank"], [/idbi|ibkl/i, "IDBI Bank"], [/au small|aubl/i, "AU Small Finance Bank"],
  [/standard chartered|scbl/i, "Standard Chartered Bank"], [/south indian|sibl/i, "South Indian Bank"], [/karnataka bank|karb/i, "Karnataka Bank"],
];
// An IFSC (HDFC0001234) starts with the bank's four letters: split them off so the name patterns see them.
const bankOf = (text: string) => (BANKS.find(([re]) => re.test(text.replace(/\b([A-Z]{4})0[A-Z0-9]{6}\b/g, "$1 ")))?.[1]) ?? null;
const last4Of = (text: string) => {
  const m = /\b(?:a\/c|acct\.?|account)\s*(?:no\.?|number|num|#)?\s*[:.\-]?\s*([Xx*]*\d[\dXx* -]{2,})/i.exec(text);
  const digits = m?.[1].replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : null;
};
const NOISE = /\bpage\s*\d|statement of account|registered office|computer generated|end of statement|opening balance|closing balance|total\b/i;

/** Rows of cells -> lines. `join` is for PDFs, where a long narration wraps onto a second row that has no date. */
export function readTable(rows: string[][], join = false, hint = ""): ParsedStatement {
  const h = rows.findIndex((r) => headerCols(r));
  if (h < 0) throw new StatementError(NO_TABLE);
  const c = headerCols(rows[h])!;
  const preamble = rows.slice(0, h).map((r) => r.join(" ")).join("\n");
  const lines: StatementLine[] = [];
  let last: StatementLine | null = null; // for wrapped narration
  let prevBal: bigint | null = null; // for a statement that gives one Amount column with no Dr/Cr
  for (const r of rows.slice(h + 1)) {
    if (r.length === 0) { last = null; continue; } // page break in a PDF
    if (headerCols(r)) continue; // the heading repeated on each page
    const on = parseDate(r[c.date]);
    const text = (r[c.narr] ?? "").trim();
    if (!on) {
      if (join && last && text && r.every((x, i) => i === c.narr || !x) && !NOISE.test(text)) last.narration += ` ${text}`;
      continue;
    }
    const balRaw = c.balance >= 0 ? parseAmount(r[c.balance]) : null;
    const balance = balRaw ? (balRaw.neg || balRaw.dir === "dr" ? -balRaw.v : balRaw.v) : null;
    let debit = 0n, credit = 0n;
    if (c.debit >= 0 && c.credit >= 0) { debit = parseAmount(r[c.debit])?.v ?? 0n; credit = parseAmount(r[c.credit])?.v ?? 0n; }
    else {
      const a = parseAmount(r[c.amount]);
      if (!a) continue;
      const dir = a.dir ?? typeDir(r[c.type]) ?? (a.neg ? "dr" : null) ?? (balance !== null && prevBal !== null ? (balance > prevBal ? "cr" : "dr") : null);
      if (!dir) throw new StatementError("We could not tell which amounts are money out and which are money in. Download the statement again with separate Debit and Credit columns, or a Dr/Cr column.");
      if (dir === "dr") debit = a.v; else credit = a.v;
    }
    if (debit === 0n && credit === 0n) continue; // opening balance rows and the like
    if (balance !== null) prevBal = balance;
    last = { on, narration: text, debit, credit, balance };
    lines.push(last);
    if (lines.length > MAX_ROWS) throw new StatementError(`This statement has more than ${MAX_ROWS.toLocaleString("en-IN")} transactions. Upload it in parts, one or two quarters at a time.`);
  }
  if (lines.length < MIN_ROWS) throw new StatementError(`We found only ${lines.length} transaction${lines.length === 1 ? "" : "s"} in this file, which is too few to work with. Check that you downloaded the full statement, not a single page or a summary.`);
  // Some banks list the newest first. Put the oldest first so running balances read forward.
  let up = 0, down = 0;
  for (let i = 1; i < lines.length; i++) { if (lines[i].on > lines[i - 1].on) up++; else if (lines[i].on < lines[i - 1].on) down++; }
  if (down > up) lines.reverse();
  const dates = lines.map((l) => l.on).sort();
  return { lines, bankName: bankOf(`${preamble} ${hint}`), accountLast4: last4Of(preamble), periodFrom: dates[0], periodTo: dates[dates.length - 1] };
}

// ---------- CSV ----------

/** Split CSV text into rows of cells. Handles quoted fields with commas, doubled quotes, and tab, semicolon or pipe separators. */
export function splitCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const sample = text.split(/\r?\n/).slice(0, 80);
  const delim = ["\t", ";", "|", ","].map((d) => [d, sample.filter((l) => l.split(d).length >= 4).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (ch === '"' && !cell.trim()) { quoted = true; cell = ""; }
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

// ---------- PDF ----------

type Cell = { text: string; x: number; r: number };
type Item = { str: string; x: number; y: number; width: number; fontSize: number };

/** Positioned text fragments -> visual rows of cells, top to bottom. Fragments closer than one letter-height belong to the same cell. */
function visualRows(items: Item[]): Cell[][] {
  const rows: { y: number; parts: Item[] }[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const tol = Math.max(2, it.fontSize * 0.45);
    const row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
    if (row) row.parts.push(it); else rows.push({ y: it.y, parts: [it] });
  }
  return rows.sort((a, b) => b.y - a.y).map((row) => {
    const cells: Cell[] = [];
    for (const p of row.parts.sort((a, b) => a.x - b.x)) {
      const prev = cells[cells.length - 1];
      if (prev && p.x - prev.r <= p.fontSize) { prev.text += ` ${p.str.trim()}`; prev.r = p.x + p.width; }
      else cells.push({ text: p.str.trim(), x: p.x, r: p.x + p.width });
    }
    return cells;
  });
}

/** Put each cell under the heading it lines up with (left edge, right edge or middle), so an empty Debit column does not shift the rest. */
function align(cells: Cell[], head: Cell[]): string[] {
  const out = head.map(() => "");
  for (const c of cells) {
    let best = 0, d = Infinity;
    head.forEach((h, i) => {
      const gap = Math.min(Math.abs(c.x - h.x), Math.abs(c.r - h.r), Math.abs((c.x + c.r - h.x - h.r) / 2));
      if (gap < d) { d = gap; best = i; }
    });
    out[best] = out[best] ? `${out[best]} ${c.text}` : c.text;
  }
  return out;
}

export async function parsePdf(bytes: Uint8Array, hint = ""): Promise<ParsedStatement> {
  let pages: Item[][];
  try { pages = (await extractTextItems(await getDocumentProxy(new Uint8Array(bytes)))).items.slice(0, MAX_PAGES); }
  catch { throw new StatementError("This PDF could not be opened. It may be damaged or protected with a password. Download it again, or use the CSV export."); }
  if (pages.flat().map((i) => i.str).join("").replace(/\s/g, "").length < 40)
    throw new StatementError("This PDF is a picture of a statement and has no text we can read. Download the statement from net banking as a PDF or CSV instead of scanning or photographing it.");
  const rows: string[][] = [];
  let head: Cell[] | null = null;
  for (const page of pages) {
    for (const cells of visualRows(page)) {
      if (!head && headerCols(cells.map((x) => x.text))) head = cells;
      rows.push(head ? align(cells, head) : cells.map((x) => x.text));
    }
    rows.push([]); // marks the page break
  }
  return readTable(rows, true, hint);
}

/** Read an uploaded statement. */
export async function parseStatement(bytes: Buffer, kind: "pdf" | "csv", fileName = ""): Promise<ParsedStatement> {
  if (kind === "pdf") return parsePdf(new Uint8Array(bytes), fileName);
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.startsWith("%PDF")) throw new StatementError("This file is a PDF with a .csv name. Upload it as a PDF.");
  return readTable(splitCsv(text), false, fileName);
}
