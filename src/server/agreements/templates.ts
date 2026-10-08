import { formatINR } from "../../lib/money";

// DRAFT TEMPLATES: the clause text must be reviewed by counsel before any real use (PRD risk register).
// Documents are built as a small structured model and rendered to PDF (see pdf.ts), so user-controlled values are plain
// data: nothing is ever interpreted as markup.

/** A run of text. A { b } run is bold. */
export type Run = string | { b: string };
export type Block = { h: string } | { p: Run[] } | { ol: Run[][] } | { table: [string, string][] };
export type Doc = { title: string; blocks: Block[] };

const date = (d: Date) => d.toISOString().slice(0, 10);
const doc = (title: string, blocks: Block[]): Doc => ({ title, blocks });

/** Plain text of a document: for tests, search and audit. */
export function docText(d: Doc): string {
  const run = (r: Run[]) => r.map((x) => (typeof x === "string" ? x : x.b)).join("");
  return [d.title, ...d.blocks.flatMap((b) => ("h" in b ? [b.h] : "p" in b ? [run(b.p)] : "ol" in b ? b.ol.map(run) : b.table.map(([k, v]) => `${k}: ${v}`)))].join("\n");
}

export type MasterData = { seller: { legalName: string; gstin: string | null }; now: Date };
export function masterAgreement({ seller, now }: MasterData) {
  return doc("Master Invoice Financing Agreement", [
    { h: "Master Invoice Financing Agreement" },
    { p: [`Date: ${date(now)}`] },
    { p: ["Between ", { b: "Marichi Labs" }, " (the “Financier”) and ", { b: seller.legalName }, seller.gstin ? ` (GSTIN ${seller.gstin})` : "", " (the “Seller”)."] },
    { ol: [
      [{ b: "Assignment. " }, "The Seller assigns to the Financier the receivables described in each Invoice Schedule signed under this agreement."],
      [{ b: "Genuineness. " }, "The Seller warrants each assigned invoice is genuine, undisputed, not previously assigned or financed, and for goods or services actually delivered."],
      [{ b: "Recourse. " }, "Unless a Schedule states otherwise, financing is with recourse: if the Buyer does not pay within the grace period after the due date, the Seller repays the outstanding amount on demand."],
      [{ b: "Collections. " }, "The Seller shall direct the Buyer to pay only into the collection account notified by the Financier, and hold any amount received directly in trust for the Financier."],
      [{ b: "Charges. " }, "The discount, fees and any penal charges are those stated in each Schedule."],
      [{ b: "Governing law. " }, "[To be completed by counsel.]"],
    ] },
  ]);
}

export type ScheduleData = {
  seller: { legalName: string }; buyer: { legalName: string; gstin: string | null };
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  offer: { advanceAmount: bigint; feeAmount: bigint; discountBps: number; tenorDays: number; expectedDiscount: bigint; recourse: boolean; expiresAt: Date };
  now: Date;
};
export function invoiceSchedule(d: ScheduleData) {
  return doc("Invoice Schedule", [
    { h: "Invoice Schedule" },
    { p: [`Date: ${date(d.now)}. Issued under the Master Invoice Financing Agreement between Marichi Labs and ${d.seller.legalName}.`] },
    { table: [
      ["Buyer", d.buyer.legalName + (d.buyer.gstin ? ` (GSTIN ${d.buyer.gstin})` : "")],
      ["Invoice number", d.invoice.invoiceNumber],
      ["Invoice date / due date", `${d.invoice.invoiceDate} / ${d.invoice.dueDate}`],
      ["Invoice amount", formatINR(d.invoice.amount)],
      ["Advance", formatINR(d.offer.advanceAmount)],
      ["Processing fee (deducted upfront)", formatINR(d.offer.feeAmount)],
      ["Net amount paid to Seller", formatINR(d.offer.advanceAmount - d.offer.feeAmount)],
      ["Discount rate", `${d.offer.discountBps / 100}% per annum on the advance, accruing daily`],
      [`Expected discount over ${d.offer.tenorDays} days`, formatINR(d.offer.expectedDiscount)],
      ["Recourse", d.offer.recourse ? "With recourse to the Seller" : "Without recourse"],
    ] },
    { p: ["By signing, the Seller accepts these terms and assigns the above invoice to Marichi Labs."] },
  ]);
}

export type NoticeData = {
  seller: { legalName: string }; buyer: { legalName: string };
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  collection: { accountNumber: string; ifsc: string }; now: Date;
};
export function assignmentNotice(d: NoticeData) {
  return doc("Notice of Assignment", [
    { h: "Notice of Assignment of Receivable" },
    { p: [`Date: ${date(d.now)}`] },
    { p: ["To: ", { b: d.buyer.legalName }] },
    { p: ["Please take notice that ", { b: d.seller.legalName }, " has assigned to ", { b: "Marichi Labs" }, ` its right to receive payment of invoice `, { b: d.invoice.invoiceNumber }, ` dated ${d.invoice.invoiceDate} for `, { b: formatINR(d.invoice.amount) }, ", due on ", { b: d.invoice.dueDate }, "."] },
    { p: ["Payment must be made only to the following collection account. Payment to the Seller or to any other account will not discharge your obligation."] },
    { table: [
      ["Beneficiary", "Marichi Labs (collection account)"],
      ["Account number", d.collection.accountNumber],
      ["IFSC", d.collection.ifsc],
      ["Reference", `Invoice ${d.invoice.invoiceNumber}`],
    ] },
  ]);
}
