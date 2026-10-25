// Reading the fields of an invoice out of its text. Pure: text in, fields and notes out, so it is fast and fully testable.
// Everything here is a SUGGESTION for the upload form: the seller checks each value, and duplicate, e-invoice and buyer checks
// still run on submit. A field is left empty rather than guessed.
import { market } from "../../../lib/countries";
import type { OcrFields } from "../gateway";

export type Parsed = { fields: OcrFields; warnings: string[] };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** The first date in a piece of text, day first (as written in India and Zambia), in any of the usual shapes. */
export function findDate(s: string): string | null {
  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(s);
  if (m) { const r = iso(+m[1], +m[2], +m[3]); if (r) return r; }
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(s);
  if (m) { const r = iso(+m[3], +m[2], +m[1]); if (r) return r; }
  m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,-]+(\d{4}|\d{2})\b/i.exec(s);
  if (m) { const r = iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]); if (r) return r; }
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s);
  if (m) { const r = iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]); if (r) return r; }
  return null;
}

const addDays = (isoDate: string, n: number) => new Date(Date.parse(isoDate) + n * 86_400_000).toISOString().slice(0, 10);

/** Every money-looking number in a line, as plain digits with an optional decimal point. Handles 1,23,456.00 and 1,234,567.00. */
export function amountsIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\w])/g)) {
    const v = m[1].replace(/,/g, "");
    if (Number(v) > 0) out.push(v);
  }
  return out;
}
const num = (s: string) => Number(s);

function currencyOf(text: string): string | null {
  if (/₹|\bRs\.?(?=\s|\d)|\bINR\b/i.test(text)) return "INR";
  if (/\bZMW\b|\bZK\b|\bkwacha\b/i.test(text)) return "ZMW";
  if (/\bUSD\b|US\$|\$\s?\d/.test(text)) return "USD";
  if (/\bEUR\b|€/.test(text)) return "EUR";
  if (/\bGBP\b|£/.test(text)) return "GBP";
  if (/\bAED\b/.test(text)) return "AED";
  return null;
}

type Hit = { value: string; line: string };
const cells = (l: string) => l.split(/\s{2,}|\s\|\s|\t/).map((c) => c.trim()).filter(Boolean);
/**
 * The value after a label: on the same line; or, in a table whose header row holds several labels, in the same column of the next
 * row; or, for a lone label, the first value on the line below it.
 */
function labelled(lines: string[], label: RegExp, take: (s: string) => string | null, skip?: RegExp): Hit | null {
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]);
    if (!m || (skip && skip.test(lines[i]))) continue;
    const same = take(lines[i].slice(m.index + m[0].length));
    if (same) return { value: same, line: lines[i] };
    const next = lines[i + 1];
    if (!next) continue;
    const head = cells(lines[i]);
    if (head.length > 1) { // a header row: read down the same column
      const col = head.findIndex((c) => label.test(c));
      const row = cells(next);
      const v = col >= 0 && row.length >= head.length ? take(row[col]) : null;
      if (v) return { value: v, line: next };
      continue;
    }
    const below = take(next);
    if (below) return { value: below, line: next };
  }
  return null;
}

const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9/\-_.]{1,38}$/;
const NOT_ID = /^(?:date|dated|no|number|invoice|bill|tax|gst|gstin|tpin|due|total|to|from|of|the|and|for)$/i;
/** First token after the label that looks like an identifier: has a digit, is not a label word, is not a date. */
function idToken(s: string): string | null {
  for (const raw of s.replace(/^[\s:#.\-–]+/, "").split(/[\s|,;]+/)) {
    const t = raw.replace(/^[:#.\-–]+|[:.,;]+$/g, "");
    if (ID_TOKEN.test(t) && /\d/.test(t) && !NOT_ID.test(t) && !findDate(t) && t.length >= 2) return t;
  }
  return null;
}

function taxIds(text: string): { id: string; index: number }[] {
  const pack = market().ids.taxReg;
  const core = pack.pattern.source.replace(/^\^|\$$/g, "");
  const found: { id: string; index: number }[] = [];
  const labelled = new RegExp(`${pack.label.replace(/[^A-Za-z0-9 ]/g, "")}[^A-Za-z0-9]{0,8}(${core})`, "gi");
  for (const m of text.matchAll(labelled)) found.push({ id: m[1].toUpperCase(), index: m.index ?? 0 });
  // Indian GSTINs are distinctive enough to find with no label at all.
  if (pack.label === "GSTIN") for (const m of text.matchAll(new RegExp(`\\b${core}\\b`, "gi"))) if (!found.some((f) => f.id === m[0].toUpperCase())) found.push({ id: m[0].toUpperCase(), index: m.index ?? 0 });
  return found.sort((a, b) => a.index - b.index);
}

const BUYER = /bill(?:ed)?\s*to|buyer|consignee|ship(?:ped)?\s*to|customer|sold\s*to|recipient|invoice\s*to|client/i;
const SELLER = /seller|supplier|vendor|sold\s*by|from\b|registered\s*office|remit/i;

export function parseInvoice(text: string): Parsed {
  // Wide gaps are column breaks in a table, so they are kept (as three spaces); every other run of spaces becomes one.
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, "   ").replace(/ {3,}/g, "\u0001").replace(/\s+/g, " ").replace(/\u0001/g, "   ").trim()).filter(Boolean);
  const warnings: string[] = [];
  const fields: OcrFields = {
    invoiceNumber: null, invoiceDate: null, dueDate: null, totalAmount: null, currency: currencyOf(text),
    sellerName: null, sellerGstin: null, buyerName: null, buyerGstin: null, irn: null, poReference: null,
  };

  // Invoice number
  const numLabel = /\b(?:tax\s+)?invoice\s*(?:no\.?|number|num\.?|#|id)(?![a-z])|\binv(?:oice)?\.?\s*(?:no\.?|#)(?![a-z])|\bbill\s*(?:no\.?|number)(?![a-z])|\bdocument\s*(?:no\.?|number)(?![a-z])/i;
  fields.invoiceNumber = labelled(lines, numLabel, idToken)?.value ?? null;
  if (!fields.invoiceNumber) {
    const m = /\b(INV[-/_]?(?=[A-Z0-9/\-_]*\d)[A-Z0-9][A-Z0-9/\-_]{1,30})\b/i.exec(text);
    if (m) { fields.invoiceNumber = m[1]; warnings.push("The invoice number was found without a label. Check it."); }
  }

  // Dates: the due date first, so a "due date" line is never mistaken for the invoice date
  const dueLabel = /\bdue\s*(?:date|on|by)\b|\bpayment\s*due\b|\bpay(?:able)?\s*(?:by|on)\b|\bmaturity\b|\bdate\s*due\b/i;
  const dueHit = labelled(lines, dueLabel, findDate);
  fields.dueDate = dueHit?.value ?? null;
  const dateLabel = /\b(?:invoice|bill|tax\s*invoice|issue)\s*date\b|\bdate\s*of\s*(?:invoice|issue)\b|\bdated\b|\bdate\b/i;
  const invHit = labelled(lines, dateLabel, findDate, /due|delivery|supply|ship|order|po\b|p\.o\./i);
  fields.invoiceDate = invHit?.value ?? null;
  if (!fields.invoiceDate) {
    const first = lines.map((l) => (dueLabel.test(l) ? null : findDate(l))).find(Boolean) ?? null;
    if (first) { fields.invoiceDate = first; warnings.push("The invoice date was taken from the first date on the page. Check it."); }
  }
  if (!fields.dueDate && fields.invoiceDate) {
    const t = /(?:net|terms?|payment\s*terms?|credit)[^\d\n]{0,18}(\d{1,3})\s*days?|within\s*(\d{1,3})\s*days?/i.exec(text);
    const days = t ? Number(t[1] ?? t[2]) : 0;
    if (days > 0 && days <= 365) { fields.dueDate = addDays(fields.invoiceDate, days); warnings.push(`The due date was worked out from the payment terms (${days} days). Check it.`); }
  }

  // Total payable: the strongest label wins; within it the largest value, since the grand total is the biggest figure
  const classes: { label: RegExp; weak?: boolean }[] = [
    { label: /grand\s*total|total\s*(?:amount\s*)?(?:payable|due)|amount\s*(?:payable|due)|balance\s*(?:due|payable)|net\s*(?:amount\s*)?payable|invoice\s*(?:total|value|amount)|total\s*invoice\s*(?:value|amount)|total\s*\(?\s*(?:incl|inclusive)/i },
    { label: /\btotal\b/i, weak: true },
  ];
  const NOT_TOTAL = /sub\s*-?\s*total|taxable|total\s*(?:tax|gst|vat|cgst|sgst|igst|discount|qty|quantity|units|items|weight)|in\s*words|amount\s*chargeable|round(?:ing)?\s*off/i;
  for (const c of classes) {
    const vals: { v: string; line: string }[] = [];
    lines.forEach((l, i) => {
      if (!c.label.test(l) || NOT_TOTAL.test(l)) return;
      const rest = l.replace(c.label, " ");
      const here = amountsIn(rest);
      const found = here.length ? here : amountsIn(lines[i + 1] ?? "");
      if (found.length) vals.push({ v: found.reduce((a, b) => (num(b) > num(a) ? b : a)), line: l });
    });
    if (vals.length) {
      const best = vals.reduce((a, b) => (num(b.v) > num(a.v) ? b : a));
      fields.totalAmount = best.v;
      if (c.weak) warnings.push(`The amount was taken from the line "${best.line.slice(0, 60)}". Check that it is the total payable including tax.`);
      if (new Set(vals.map((x) => x.v)).size > 1 && !c.weak) warnings.push("Several different totals were found; the largest was used. Check it.");
      break;
    }
  }

  // Tax registration numbers: seller and buyer by the words around them, otherwise by order
  const ids = taxIds(text);
  const lineStart: number[] = []; { let at = 0; for (const l of text.split(/\r?\n/)) { lineStart.push(at); at += l.length + 1; } }
  const lineAt = (idx: number) => { let k = 0; while (k + 1 < lineStart.length && lineStart[k + 1] <= idx) k++; return k; };
  const rawLines = text.split(/\r?\n/);
  const context = (idx: number) => rawLines.slice(Math.max(0, lineAt(idx) - 3), lineAt(idx) + 1).join(" ");
  const sorted = ids.map((x) => ({ ...x, buyer: BUYER.test(context(x.index)), seller: SELLER.test(context(x.index)) }));
  const buyer = sorted.find((x) => x.buyer && !x.seller) ?? (sorted.length > 1 ? sorted[1] : undefined);
  const seller = sorted.find((x) => x.seller && !x.buyer && x !== buyer) ?? sorted.find((x) => x !== buyer);
  fields.sellerGstin = seller?.id ?? null;
  fields.buyerGstin = buyer?.id ?? null;
  if (sorted.length > 1 && !sorted.some((x) => x.buyer || x.seller)) warnings.push("The seller and buyer numbers were told apart by their order on the page. Check them.");

  // E-invoice reference: 64 hex characters in India; other markets print their own, which a person types
  fields.irn = /\b[0-9a-f]{64}\b/i.exec(text)?.[0].toLowerCase() ?? null;

  // Purchase order
  const po = labelled(lines, /\b(?:p\.?\s?o\.?\s*(?:no\.?|number|ref(?:erence)?|#)|purchase\s*order(?:\s*(?:no\.?|number|ref(?:erence)?))?)(?![a-z])/i, idToken, /p\.?\s?o\.?\s*box/i);
  fields.poReference = po?.value ?? null;

  // Names: the buyer follows the "Bill to" style label; the seller is the first real heading at the top
  const nameOf = (s: string) => { const t = s.replace(/^[\s:\-–]+/, "").replace(/\b(?:gstin|tpin|pan|cin)\b.*$/i, "").trim(); return t.length >= 3 && /[A-Za-z]{3}/.test(t) && !/^(?:tax\s+)?invoice$/i.test(t) ? t.slice(0, 80) : null; };
  fields.buyerName = labelled(lines, BUYER, nameOf)?.value ?? null;
  fields.sellerName = lines.slice(0, 12).map((l) => (/invoice|date|gstin|tpin|bill\s*to|page|original|duplicate|copy/i.test(l) || findDate(l) ? null : nameOf(l))).find(Boolean) ?? null;

  return { fields, warnings };
}
