#!/usr/bin/env node
// Tally agent: runs on the PC where Tally Prime runs, reads Sales vouchers from Tally and sends them to the platform.
// Needs Node 18 or newer and nothing else (no npm install). Tally itself must be open with the company loaded and its
// HTTP/XML server switched on (default port 9000): https://help.tallysolutions.com/tallyprime-as-server/
//
// Settings (environment variables):
//   TALLY_COMPANY      company name exactly as Tally shows it                     (required)
//   PLATFORM_URL       the platform's address, e.g. https://app.example.com       (required)
//   PLATFORM_API_KEY   a seller API key made in the platform                      (required)
//   TALLY_URL          where Tally listens                                        (default http://localhost:9000)
//   FROM, TO           date range, YYYY-MM-DD                                     (default: last 30 days to today)
//
// Example (Windows PowerShell):
//   $env:TALLY_COMPANY="Acme Traders"; $env:PLATFORM_URL="https://app.example.com"; $env:PLATFORM_API_KEY="mk_live_..."
//   node tally-agent.mjs
// Run it from Task Scheduler for a daily sync. Re-sending an invoice that is already on the platform is safe: it is reported as a duplicate.
//
// The request below must match tallyExportRequest() in src/server/erp/connectors/tally.ts (a test checks they are the same).
import { pathToFileURL } from "node:url";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COLLECTION = "MarichiSalesVouchers";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function tallyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const dt = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]) throw new Error(`"${iso}" is not a date (use YYYY-MM-DD)`);
  return `${+m[3]}-${MONTHS[+m[2] - 1]}-${m[1]}`;
}

export function tallyRequest({ company, from, to }) {
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
    `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>`,
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

/** Tally may answer in UTF-16 (UNVERIFIED: the public pages do not say). Detect it by its byte-order mark, else read UTF-8. */
export function decodeReply(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  return new TextDecoder("utf-8").decode(b);
}

async function main() {
  const env = process.env;
  const need = ["TALLY_COMPANY", "PLATFORM_URL", "PLATFORM_API_KEY"].filter((k) => !env[k]);
  if (need.length) throw new Error(`set ${need.join(", ")} (see the notes at the top of this file)`);
  const day = (d) => d.toISOString().slice(0, 10);
  const to = env.TO || day(new Date());
  const from = env.FROM || day(new Date(Date.now() - 30 * 86400_000));
  const tally = env.TALLY_URL || "http://localhost:9000";
  const platform = env.PLATFORM_URL.replace(/\/+$/, "");

  console.log(`Asking Tally at ${tally} for Sales vouchers of "${env.TALLY_COMPANY}", ${from} to ${to} ...`);
  let xml;
  try {
    const r = await fetch(tally, { method: "POST", headers: { "content-type": "text/xml; charset=utf-8" }, body: tallyRequest({ company: env.TALLY_COMPANY, from, to }) });
    if (!r.ok) throw new Error(`Tally answered HTTP ${r.status}`);
    xml = decodeReply(await r.arrayBuffer());
  } catch (e) {
    throw new Error(`could not read from Tally (${e.message}). Is Tally open with the company loaded and the HTTP server on?`);
  }
  if (!/<VOUCHER[\s>]/i.test(xml)) { console.log("Tally returned no vouchers for that range. Nothing to send."); return; }

  console.log(`Got ${xml.length} characters from Tally. Uploading to ${platform} ...`);
  const r = await fetch(`${platform}/api/v1/erp/tally`, { method: "POST", headers: { authorization: `Bearer ${env.PLATFORM_API_KEY}`, "content-type": "application/xml; charset=utf-8" }, body: xml });
  const body = await r.text();
  if (!r.ok) throw new Error(`the platform answered HTTP ${r.status}: ${body}`);
  console.log(body);
}

// Run only when started from the command line, so a test can import tallyRequest without sending anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
}
