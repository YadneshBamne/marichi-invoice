import { formatINR } from "../../lib/money";

// DRAFT TEMPLATES: the clause text must be reviewed by counsel before any real use (PRD risk register).
// Every interpolated value goes through esc(): legal names etc. are user-controlled.
export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
  `<style>body{font:14px/1.5 Georgia,serif;max-width:720px;margin:2rem auto;padding:0 1rem}td,th{padding:4px 12px 4px 0;text-align:left;vertical-align:top}</style>` +
  `</head><body><p style="color:#a00"><b>DRAFT TEMPLATE: pending legal review.</b></p>${body}</body></html>`;

const date = (d: Date) => d.toISOString().slice(0, 10);

export type MasterData = { seller: { legalName: string; gstin: string | null }; now: Date };
export function masterAgreement({ seller, now }: MasterData) {
  return page("Master Invoice Financing Agreement", `
<h1>Master Invoice Financing Agreement</h1>
<p>Date: ${date(now)}</p>
<p>Between <b>Marichi Labs</b> (the &ldquo;Financier&rdquo;) and <b>${esc(seller.legalName)}</b>${seller.gstin ? ` (GSTIN ${esc(seller.gstin)})` : ""} (the &ldquo;Seller&rdquo;).</p>
<ol>
<li><b>Assignment.</b> The Seller assigns to the Financier the receivables described in each Invoice Schedule signed under this agreement.</li>
<li><b>Genuineness.</b> The Seller warrants each assigned invoice is genuine, undisputed, not previously assigned or financed, and for goods/services actually delivered.</li>
<li><b>Recourse.</b> Unless a Schedule states otherwise, financing is with recourse: if the Buyer does not pay within the grace period after the due date, the Seller repays the outstanding amount on demand.</li>
<li><b>Collections.</b> The Seller shall direct the Buyer to pay only into the collection account notified by the Financier, and hold any amount received directly in trust for the Financier.</li>
<li><b>Charges.</b> The discount, fees and any penal charges are those stated in each Schedule.</li>
<li><b>Governing law.</b> [To be completed by counsel.]</li>
</ol>`);
}

export type ScheduleData = {
  seller: { legalName: string }; buyer: { legalName: string; gstin: string | null };
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  offer: { advanceAmount: bigint; feeAmount: bigint; discountBps: number; tenorDays: number; expectedDiscount: bigint; recourse: boolean; expiresAt: Date };
  now: Date;
};
export function invoiceSchedule(d: ScheduleData) {
  const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  return page("Invoice Schedule", `
<h1>Invoice Schedule</h1>
<p>Date: ${date(d.now)}. Issued under the Master Invoice Financing Agreement between Marichi Labs and ${esc(d.seller.legalName)}.</p>
<table>
${row("Buyer", d.buyer.legalName + (d.buyer.gstin ? ` (GSTIN ${d.buyer.gstin})` : ""))}
${row("Invoice number", d.invoice.invoiceNumber)}
${row("Invoice date / due date", `${d.invoice.invoiceDate} / ${d.invoice.dueDate}`)}
${row("Invoice amount", formatINR(d.invoice.amount))}
${row("Advance", formatINR(d.offer.advanceAmount))}
${row("Processing fee (deducted upfront)", formatINR(d.offer.feeAmount))}
${row("Net amount paid to Seller", formatINR(d.offer.advanceAmount - d.offer.feeAmount))}
${row("Discount rate", `${d.offer.discountBps / 100}% per annum on the advance, accruing daily`)}
${row("Expected discount over " + d.offer.tenorDays + " days", formatINR(d.offer.expectedDiscount))}
${row("Recourse", d.offer.recourse ? "With recourse to the Seller" : "Without recourse")}
</table>
<p>By signing, the Seller accepts these terms and assigns the above invoice to Marichi Labs.</p>`);
}

export type NoticeData = {
  seller: { legalName: string }; buyer: { legalName: string };
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  collection: { accountNumber: string; ifsc: string }; now: Date;
};
export function assignmentNotice(d: NoticeData) {
  return page("Notice of Assignment", `
<h1>Notice of Assignment of Receivable</h1>
<p>Date: ${date(d.now)}</p>
<p>To: <b>${esc(d.buyer.legalName)}</b></p>
<p>Please take notice that <b>${esc(d.seller.legalName)}</b> has assigned to <b>Marichi Labs</b> its right to receive payment of
invoice <b>${esc(d.invoice.invoiceNumber)}</b> dated ${esc(d.invoice.invoiceDate)} for <b>${esc(formatINR(d.invoice.amount))}</b>,
due on <b>${esc(d.invoice.dueDate)}</b>.</p>
<p>Payment must be made only to the following collection account. Payment to the Seller or to any other account will not discharge your obligation.</p>
<table>
<tr><th>Beneficiary</th><td>Marichi Labs (collection account)</td></tr>
<tr><th>Account number</th><td>${esc(d.collection.accountNumber)}</td></tr>
<tr><th>IFSC</th><td>${esc(d.collection.ifsc)}</td></tr>
<tr><th>Reference</th><td>Invoice ${esc(d.invoice.invoiceNumber)}</td></tr>
</table>`);
}
