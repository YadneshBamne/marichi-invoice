// Tally Prime connector: builds the XML request that asks Tally for Sales vouchers, and turns the XML Tally sends back into
// the platform's normalised invoice rows. Tally only listens on the customer's own PC, so a small agent (scripts/tally-agent.mjs)
// sends the request, collects the reply and uploads it; this file never talks to Tally itself.
//
// Written from Tally's public developer documentation:
//   Request structure (HEADER, TYPE/ID, DESC/STATICVARIABLES, TDL/TDLMESSAGE/COLLECTION), date format "1-Apr-2024":
//     https://help.tallysolutions.com/understanding-tally-xml-tags/
//     https://help.tallysolutions.com/developer-reference/integration-capabilities/method-specific-integration/xml/
//   Sample requests and the voucher tags (VOUCHER, DATE, VOUCHERNUMBER, LEDGERENTRIES.LIST, ISDEEMEDPOSITIVE, AMOUNT,
//   ISPARTYLEDGER, BILLALLOCATIONS.LIST, dates as YYYYMMDD): https://help.tallysolutions.com/sample-xml/
//   Voucher object methods (Date, VoucherNumber, PartyLedgerName, LedgerEntries, LedgerName, Amount, BillAllocations):
//     https://help.tallysolutions.com/article/DeveloperReference/tdlreference/appendix.htm
//   HTTP server, default port 9000: https://help.tallysolutions.com/tallyprime-as-server/
//
// The public pages do not show an export of Sales vouchers with these fields, so every tag or TDL name below that the pages do
// not show is marked UNVERIFIED. Test the request against a real Tally company before relying on it.
import type { ErpInvoiceRow } from "./types";
import { kids, parseXml, text, type XNode } from "../../util/xml";

const COLLECTION = "MarichiSalesVouchers";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** ISO date (YYYY-MM-DD) to the "1-Apr-2024" style Tally's help pages use for SVFROMDATE / SVTODATE. */
function tallyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || !validDate(+m[1], +m[2], +m[3])) throw new Error(`"${iso}" is not a date (use YYYY-MM-DD)`);
  return `${+m[3]}-${MONTHS[+m[2] - 1]}-${m[1]}`;
}

/** The XML body to POST to Tally (http://localhost:9000) to get the Sales vouchers between two dates, inclusive. */
export function tallyExportRequest({ company, from, to }: { company: string; from: string; to: string }): string {
  // UNVERIFIED: the FETCH names, the PartyGSTIN / BasicDueDateOfPymt / Reference / IsCancelled / IsOptional voucher fields,
  // and $$IsSales (meant to include child voucher types of Sales) are from TDL practice, not from the public pages.
  const fields = [
    "Date", "VoucherNumber", "VoucherTypeName", "PartyLedgerName", "PartyGSTIN", "Reference", "BasicDueDateOfPymt", "IsCancelled", "IsOptional",
    "AllLedgerEntries.LedgerName", "AllLedgerEntries.IsPartyLedger", "AllLedgerEntries.Amount",
    "AllLedgerEntries.BillAllocations.Name", "AllLedgerEntries.BillAllocations.BillCreditPeriod",
  ].join(", ");
  return [
    "<ENVELOPE>",
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>" + `<ID>${COLLECTION}</ID></HEADER>`,
    "<BODY><DESC>",
    "<STATICVARIABLES>",
    `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`,
    `<SVFROMDATE TYPE="Date">${tallyDate(from)}</SVFROMDATE>`,
    `<SVTODATE TYPE="Date">${tallyDate(to)}</SVTODATE>`,
    "</STATICVARIABLES>",
    "<TDL><TDLMESSAGE>",
    `<COLLECTION NAME="${COLLECTION}" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">`,
    `<TYPE>Voucher</TYPE><FETCH>${fields}</FETCH><FILTERS>${COLLECTION}IsSales</FILTERS>`,
    "</COLLECTION>",
    `<SYSTEM TYPE="Formulae" NAME="${COLLECTION}IsSales">$$IsSales:$VoucherTypeName</SYSTEM>`,
    "</TDLMESSAGE></TDL>",
    "</DESC></BODY>",
    "</ENVELOPE>",
  ].join("\n");
}

// ---------- Reading the reply (the XML reader lives in util/xml) ----------

const parse = (xml: string) => parseXml(xml, { upperNames: true });
const yes = (s: string) => s.toLowerCase() === "yes";

/** Every VOUCHER element, wherever it sits (a collection reply and an import-style TALLYMESSAGE both work). */
function vouchersIn(n: XNode, out: XNode[] = []): XNode[] {
  for (const k of n.kids) k.name === "VOUCHER" ? out.push(k) : vouchersIn(k, out);
  return out;
}

// ---------- Values ----------

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Tally writes dates as YYYYMMDD. Returns YYYY-MM-DD, or null if it is not a real date. */
function ymd(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim());
  return m && validDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "-118000.00" to -11800000n (paise). Takes the part after "=" for foreign-currency text like "-$100 @ 83 = -8300.00". */
function toMinor(s: string): bigint | null {
  const t = (s.includes("=") ? s.slice(s.lastIndexOf("=") + 1) : s).replace(/[^\d.\-]/g, "");
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || !(m[2] || m[3])) return null;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let v = BigInt(m[2] || "0") * 100n + BigInt(frac.slice(0, 2));
  if (frac[2] >= "5") v += 1n; // round half up on a third decimal
  return m[1] ? -v : v;
}

/** A credit period ("30 Days", "2 Weeks", "45") counted from the invoice date, or a plain YYYYMMDD date. Null if unreadable. */
function dueDate(raw: string, invoiceIso: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const whole = ymd(t);
  if (whole) return whole;
  const m = /^(\d{1,4})\s*(day|week|month|year)?s?$/i.exec(t);
  if (!m) return null;
  const n = +m[1], unit = (m[2] ?? "day").toLowerCase();
  const [y, mo, d] = invoiceIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (unit === "day") dt.setUTCDate(dt.getUTCDate() + n);
  else if (unit === "week") dt.setUTCDate(dt.getUTCDate() + 7 * n);
  else if (unit === "month") dt.setUTCMonth(dt.getUTCMonth() + n);
  else dt.setUTCFullYear(dt.getUTCFullYear() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Turns Tally's reply into invoice rows. Skipped: cancelled and optional vouchers, vouchers with no number or a bad date, and
 * vouchers whose party ledger is not a debit (a sale debits the party, so Tally writes it as a NEGATIVE amount; a positive or
 * zero party amount is a reversal, not an invoice). With several ledger entries (sales, GST, round-off), only the party
 * ledger's amount counts. Fields Tally does not carry come back null.
 */
export function parseTallyVouchers(xml: string, currency = "INR"): ErpInvoiceRow[] {
  const rows: ErpInvoiceRow[] = [];
  for (const v of vouchersIn(parse(xml))) {
    if (yes(text(v, "ISCANCELLED")) || yes(text(v, "ISOPTIONAL"))) continue;
    const invoiceNumber = text(v, "VOUCHERNUMBER"), invoiceDate = ymd(text(v, "DATE")), buyerName = text(v, "PARTYLEDGERNAME");
    if (!invoiceNumber || !invoiceDate || !buyerName) continue;

    // UNVERIFIED: the entries tag is LEDGERENTRIES.LIST in the docs' samples; ALLLEDGERENTRIES.LIST is what newer exports use.
    const entries = [...kids(v, "LEDGERENTRIES.LIST"), ...kids(v, "ALLLEDGERENTRIES.LIST")];
    const party = entries.find((e) => text(e, "LEDGERNAME").toLowerCase() === buyerName.toLowerCase()) ?? entries.find((e) => yes(text(e, "ISPARTYLEDGER")));
    const paid = party && toMinor(text(party, "AMOUNT"));
    if (!party || paid == null || paid >= 0n) continue;

    // UNVERIFIED: the credit period is read from the party bill's BILLCREDITPERIOD, else the voucher's BASICDUEDATEOFPYMT.
    const bill = kids(party, "BILLALLOCATIONS.LIST").map((b) => text(b, "BILLCREDITPERIOD")).find(Boolean);
    const taxReg = text(v, "PARTYGSTIN").toUpperCase().replace(/\s+/g, "");
    rows.push({
      externalId: invoiceNumber, // a voucher number is unique within a Tally company
      invoiceNumber, buyerName, buyerTaxId: taxReg || null, invoiceDate,
      dueDate: dueDate(bill ?? text(v, "BASICDUEDATEOFPYMT"), invoiceDate) ?? dueDate(text(v, "BASICDUEDATEOFPYMT"), invoiceDate),
      amountMinor: -paid, currency, poReference: text(v, "REFERENCE") || null,
    });
  }
  return rows;
}
