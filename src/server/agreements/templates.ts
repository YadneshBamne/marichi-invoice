import { formatMoney } from "../../lib/money";
import { splitTax } from "../ledger/tax";
import { market } from "../../lib/countries";
import { termsFor, type CountryTerms } from "./country";

// DRAFT TEMPLATES: the clause text must be reviewed by counsel in each country before any real use (PRD risk register; see
// docs/PLATFORM-GUIDE.md section 6). Bracketed text is left for counsel. Documents are built as a small structured model and rendered
// to PDF (see pdf.ts), so user-controlled values are plain data: nothing is ever interpreted as markup.

/** Bump when clause text changes. It is printed on every generated document so a signed copy can always be matched to its wording. */
export const TEMPLATE_VERSION = "2026-10-v2";
export const FINANCIER_TERMS_VERSION = "2026-10-v1";
export const PLATFORM_TERMS_VERSION = "2026-10"; // the terms and privacy notice shown at signup
export const PROGRAMME_TERMS_VERSION = "2026-10-v1";

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

/** Who owns the receivable. The platform's own balance sheet, or a licensed financier that bid. Marichi Labs services both. */
export type Party = { legalName: string; platform: boolean };
export const PLATFORM: Party = { legalName: "Marichi Labs", platform: true };
const servicing = (f: Party): Run[] => (f.platform ? [] : [" ", { b: "Marichi Labs" }, ` acts as the Financier's servicing and collection agent: it verifies invoices, gives notices, collects and applies payments, and reports to both parties. It does not guarantee the Buyer's payment or the Financier's return.`]);

export type MasterData = { seller: { legalName: string; gstin: string | null }; financier?: Party; country?: CountryTerms; now: Date };
export function masterAgreement({ seller, financier = PLATFORM, country = termsFor(null), now }: MasterData) {
  const reg = country.registry ?? "any registry the law provides for assignments of receivables";
  return doc("Master Invoice Financing Agreement", [
    { h: "Master Invoice Financing Agreement" },
    { p: [`Date: ${date(now)}. Template ${TEMPLATE_VERSION}.`] },
    { p: ["Between ", { b: financier.legalName }, " (the “Financier”) and ", { b: seller.legalName }, seller.gstin ? ` (${market().ids.taxReg.label} ${seller.gstin})` : "", " (the “Seller”).", ...servicing(financier)] },
    { ol: [
      [{ b: "Assignment. " }, "Each Invoice Schedule signed under this agreement assigns the receivable it describes to the Financier, effective when the Seller signs it and the advance is paid. The parties intend an assignment of the receivable. Where financing is with recourse, the Seller's repayment obligation in clause 5 is the Seller's own obligation and does not change that intention. [Counsel to confirm the characterisation in each country.]"],
      [{ b: "Eligible invoices. " }, "Only a genuine tax invoice for goods or services actually delivered, confirmed by the Buyer, not disputed, not already assigned, financed or charged to anyone, and free of any restriction on assignment (or where the Buyer has waived it), may be assigned."],
      [{ b: "Seller's warranties. " }, "For each invoice the Seller warrants that: the receivable exists and is the Seller's to assign; the amount is correct and is owed; there is no defence, set-off or counterclaim except any the Seller has told the Financier of in writing; no other person has any interest in it; the tax invoice is authentic and is registered where the law requires; the Seller has authority to sign; and everything it has told the Financier is true."],
      [{ b: "Collections. " }, "The Buyer must pay only into the collection account in the Notice of Assignment. The Seller must not collect, settle, discount or change the terms of an assigned invoice. Anything the Seller receives for an assigned invoice is held in trust for the Financier and paid over within one business day."],
      [{ b: "Recourse and repurchase. " }, "Unless a Schedule says it is without recourse, if the Buyer has not paid in full within the grace period stated in the Schedule after the due date, the Seller repays the amount still owing on demand. Whether or not a Schedule is with recourse, the Seller must repurchase an invoice for the amount still owing if a warranty was untrue, the invoice was fraudulent, a dispute is resolved in the Buyer's favour, the invoice is cancelled or reduced by a credit note, or a payment was sent to the wrong account."],
      [{ b: "Price and charges. " }, "The advance, the processing fee, the discount rate and the penal rate for each invoice are stated in its Schedule and in the Key Facts sheet the Seller acknowledged before accepting. Discount accrues daily on the advance outstanding, on an actual-days over 365 basis. A penal charge accrues daily on overdue principal from the due date at the rate in the Schedule. Taxes on fees are as stated. There are no other charges."],
      [{ b: "Order of payments. " }, "Every payment received for an invoice is applied first to principal, then to discount, then to penal charges. Any amount left over is paid to the Seller."],
      [{ b: "Credit notes and reductions. " }, "The Seller must tell the Financier at once of any credit note, return, rebate or dispute on an assigned invoice. The Financier may reduce the advance or recover the difference."],
      [{ b: "Notice and registration. " }, `The Seller authorises the Financier, and Marichi Labs for it, to give notice of each assignment to the Buyer and to file and renew its registration in ${reg}, and to do whatever else is needed to make the assignment effective against the Buyer and third parties.`],
      [{ b: "Information. " }, "The Seller will give the Financier any record it asks for about an assigned invoice and agrees that the Financier may check the invoice with the Buyer and with the tax authority's invoice system."],
      [{ b: "Electronic signature and records. " }, `This agreement and each Schedule are signed electronically. The parties agree this is valid under ${country.esign}, and that the record of who signed, when and from where is evidence of signature.`],
      [{ b: "Data. " }, "The Seller agrees that information about it and its invoices may be shared with financiers, credit bureaus, registries, tax authorities and regulators as the law and the Marichi privacy notice permit."],
      [{ b: "Term. " }, "Either party may end this agreement for future invoices by written notice. Schedules already signed continue until everything owing under them is paid."],
      [{ b: "Governing law and forum. " }, `This agreement is governed by ${country.law}. Disputes are for ${country.forum}.`],
      [{ b: "Complaints. " }, `The Seller may complain through the Marichi grievance process and, if it is not resolved, to ${country.grievance}.`],
    ] },
  ]);
}

export type ScheduleData = {
  seller: { legalName: string }; buyer: { legalName: string; gstin: string | null };
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  offer: { advanceAmount: bigint; feeAmount: bigint; discountBps: number; tenorDays: number; expectedDiscount: bigint; recourse: boolean; expiresAt: Date };
  financier?: Party; penalBps?: number; graceDays?: number; now: Date;
};
export function invoiceSchedule(d: ScheduleData) {
  const f = d.financier ?? PLATFORM;
  return doc("Invoice Schedule", [
    { h: "Invoice Schedule" },
    { p: [`Date: ${date(d.now)}. Issued under the Master Invoice Financing Agreement between ${f.legalName} and ${d.seller.legalName}. Template ${TEMPLATE_VERSION}.`] },
    { table: [
      ["Financier (assignee)", f.legalName + (f.platform ? "" : ", serviced by Marichi Labs")],
      ["Buyer", d.buyer.legalName + (d.buyer.gstin ? ` (${market().ids.taxReg.label} ${d.buyer.gstin})` : "")],
      ["Invoice number", d.invoice.invoiceNumber],
      ["Invoice date / due date", `${d.invoice.invoiceDate} / ${d.invoice.dueDate}`],
      ["Invoice amount", formatMoney(d.invoice.amount)],
      ["Advance", formatMoney(d.offer.advanceAmount)],
      ["Processing fee (deducted upfront, including tax)", formatMoney(d.offer.feeAmount)],
      ["Net amount paid to Seller", formatMoney(d.offer.advanceAmount - d.offer.feeAmount)],
      ["Discount rate", `${d.offer.discountBps / 100}% per annum on the advance, accruing daily, actual days over 365`],
      [`Expected discount over ${d.offer.tenorDays} days`, formatMoney(d.offer.expectedDiscount)],
      ["Penal charge", d.penalBps ? `${d.penalBps / 100}% per annum on overdue principal, from the due date` : "As in the Key Facts sheet"],
      ["Grace period before recourse", `${d.graceDays ?? 5} days after the due date`],
      ["Recourse", d.offer.recourse ? "With recourse to the Seller" : "Without recourse"],
      ["Payout", "To the Seller's verified bank account"],
    ] },
    { p: ["The Seller confirms it has read the Key Facts sheet for this offer. By signing, the Seller accepts these terms and assigns the above invoice to the Financier."] },
  ]);
}

export type NoticeData = {
  seller: { legalName: string }; buyer: { legalName: string };
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  collection: { accountNumber: string; ifsc: string }; financier?: Party; now: Date;
};
export function assignmentNotice(d: NoticeData) {
  const f = d.financier ?? PLATFORM;
  return doc("Notice of Assignment", [
    { h: "Notice of Assignment of Receivable" },
    { p: [`Date: ${date(d.now)}. Template ${TEMPLATE_VERSION}.`] },
    { p: ["To: ", { b: d.buyer.legalName }] },
    { p: ["Please take notice that ", { b: d.seller.legalName }, " has assigned to ", { b: f.legalName }, ` its right to receive payment of invoice `, { b: d.invoice.invoiceNumber }, ` dated ${d.invoice.invoiceDate} for `, { b: formatMoney(d.invoice.amount) }, ", due on ", { b: d.invoice.dueDate }, ".", ...(f.platform ? [] : [" Marichi Labs collects for the assignee."])] },
    { p: ["Payment must be made only to the following collection account. Payment to the Seller or to any other account will not discharge your obligation. This notice takes effect when you receive it. Please do not change the currency or place of payment."] },
    { table: [
      ["Beneficiary", `${f.platform ? "Marichi Labs" : f.legalName + " (held by Marichi Labs)"}, collection account`],
      ["Account number", d.collection.accountNumber],
      [market().ids.bankCode.label, d.collection.ifsc],
      ["Reference", `Invoice ${d.invoice.invoiceNumber}`],
    ] },
    { p: ["If you have any defence, set-off or counterclaim against this invoice, tell us in writing within seven days of receiving this notice, quoting the invoice number. If you do not, we will treat the invoice as undisputed. On request we will give you proof of the assignment."] },
    { h: "Acknowledgement" },
    { p: ["The Buyer acknowledges this notice and will pay the invoice to the account above on the due date. To acknowledge, reply to the email this notice came with, or confirm in your Marichi account."] },
  ]);
}

export type KeyFactsData = {
  seller: { legalName: string }; buyer: { legalName: string }; financier?: Party; country?: CountryTerms;
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  offer: { id: string; advanceAmount: bigint; feeAmount: bigint; discountBps: number; tenorDays: number; expectedDiscount: bigint; recourse: boolean; expiresAt: Date };
  effectiveAprBps: number; penalBps: number; graceDays: number; now: Date;
};
/** The one-page summary a seller reads before accepting: what it costs, in the same figures as the contract. */
export function keyFacts(d: KeyFactsData) {
  const f = d.financier ?? PLATFORM;
  const country = d.country ?? termsFor(null);
  const net = d.offer.advanceAmount - d.offer.feeAmount;
  const gst = splitTax(d.offer.feeAmount).tax;
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const advPct = d.invoice.amount > 0n ? Number((d.offer.advanceAmount * 10_000n) / d.invoice.amount) : 0;
  return doc("Key Facts", [
    { h: "Key Facts: your offer in plain terms" },
    { p: [`Offer ${d.offer.id.slice(0, 8).toUpperCase()} for invoice ${d.invoice.invoiceNumber}. Prepared ${date(d.now)}. Template ${TEMPLATE_VERSION}. These figures are the same as in the Invoice Schedule you will sign.`] },
    { h: "What you get" },
    { table: [
      ["Who funds you", f.legalName + (f.platform ? "" : ", serviced by Marichi Labs")],
      ["Your invoice", `${d.invoice.invoiceNumber} to ${d.buyer.legalName}, dated ${d.invoice.invoiceDate}, due ${d.invoice.dueDate}`],
      ["Invoice amount", formatMoney(d.invoice.amount)],
      ["Advance", `${formatMoney(d.offer.advanceAmount)} (${pct(advPct)} of the invoice)`],
      ["Processing fee, paid upfront", `${formatMoney(d.offer.feeAmount)}, of which tax ${formatMoney(gst)}`],
      ["You receive now", formatMoney(net)],
    ] },
    { h: "What it costs" },
    { table: [
      ["Discount rate", `${pct(d.offer.discountBps)} a year on the advance, for each day until the buyer pays. Actual days over 365.`],
      [`Discount if the buyer pays on the due date (${d.offer.tenorDays} days)`, formatMoney(d.offer.expectedDiscount)],
      ["Total cost if the buyer pays on time", formatMoney(d.offer.feeAmount + d.offer.expectedDiscount)],
      ["All-in annual rate, fee included", `${pct(d.effectiveAprBps)} a year. This is (discount + fee) divided by what you receive now, scaled to a year.`],
      ["Other charges", "None, apart from the penal charge below if the buyer pays late."],
    ] },
    { h: "When the buyer pays, and when they do not" },
    { table: [
      ["Who pays, and where", `${d.buyer.legalName} pays the invoice into a collection account named in the notice it receives. You do not collect it.`],
      ["Order payments are applied", "Principal, then discount, then penal charges. Anything left is paid to you."],
      ["If the buyer pays late", `Discount keeps accruing at the same rate. A penal charge of ${pct(d.penalBps)} a year also accrues on the overdue principal from the due date.`],
      ["If the buyer does not pay", d.offer.recourse ? `With recourse: if the buyer has not paid ${d.graceDays} days after the due date, you must repay what is still owing on demand.` : `Without recourse: the funder bears the buyer's non-payment. You must still repay if a warranty you gave was untrue, the invoice was fraudulent or is cancelled or disputed successfully, or a payment was sent to the wrong account.`],
      ["Early repayment", "If the buyer pays early, discount stops accruing from the day it pays."],
    ] },
    { h: "Before you accept" },
    { table: [
      ["This offer is open until", d.offer.expiresAt.toISOString().replace("T", " ").slice(0, 16) + " UTC"],
      ["Nothing is binding", "until you accept the offer and sign the agreement. You may decline."],
      ["Complaints", `Raise a request in Marichi Support or write to the grievance officer. If it is not resolved, you may go to ${country.grievance}.`],
    ] },
  ]);
}

export type ConfirmationRecordData = {
  seller: { legalName: string }; buyer: { legalName: string };
  invoice: { invoiceNumber: string; invoiceDate: string; dueDate: string; amount: bigint };
  wording: string[]; version: string; via: "buyer" | "link"; email: string; at: Date; ip: string | null; userAgent: string | null;
};
/** The buyer's confirmation as a record anyone can keep: exactly what it agreed to, who confirmed, when and from where. */
export function confirmationRecord(d: ConfirmationRecordData) {
  return doc("Confirmation Record", [
    { h: "Record of invoice confirmation" },
    { p: [`Recorded ${d.at.toISOString().replace("T", " ").slice(0, 19)} UTC. Wording version ${d.version}. Template ${TEMPLATE_VERSION}.`] },
    { table: [
      ["Invoice", `${d.invoice.invoiceNumber}, dated ${d.invoice.invoiceDate}, due ${d.invoice.dueDate}`],
      ["Amount", formatMoney(d.invoice.amount)],
      ["From (seller)", d.seller.legalName],
      ["To (buyer)", d.buyer.legalName],
      ["Confirmed by", `${d.email}, ${d.via === "link" ? "verified by a one-time code sent to that address" : "signed in to the buyer's Marichi account"}`],
      ["From", [d.ip, d.userAgent].filter(Boolean).join(" · ") || "not recorded"],
    ] },
    { h: "What the buyer agreed to" },
    { ol: d.wording.map((w) => [w]) },
  ]);
}

/** Terms a financier accepts when it applies. Shown in full on the application page; acceptance is recorded with the version. */
export function financierTerms(): Doc {
  return doc("Financier Participation Terms", [
    { h: "Financier participation terms" },
    { p: [`Version ${FINANCIER_TERMS_VERSION}. Draft: to be reviewed by counsel in each country before use.`] },
    { ol: [
      [{ b: "Who you are. " }, "You are a licensed institution. You confirm the licence you give us is valid, covers the activity and the countries you list, and that you will tell us within one business day if it lapses, is restricted or is withdrawn. We may suspend you at once if it does."],
      [{ b: "Your funds. " }, "Cash you send for funding is held in a ring-fenced account at a licensed bank, recorded in a ledger account in your name, and is not our money. You may withdraw funds that are not promised to an accepted deal. We record deposits and withdrawals only after the bank confirms them."],
      [{ b: "Your mandate. " }, "You set what you will fund and a credit limit for each buyer. We check every bid against them, including bids made automatically on your standing instructions, and we do not accept a bid that breaks them."],
      [{ b: "Bids. " }, "A bid is an offer you cannot take back once the seller accepts it. Until then you may withdraw it. Accepted advances are set aside from your available funds."],
      [{ b: "What you own. " }, "When an advance is paid out you own the receivable it financed. We service it for you: we verify it, give the buyer notice, collect and apply payments, and report to you. We do not guarantee the buyer's payment, the seller's repayment or your return."],
      [{ b: "Losses. " }, "If an invoice is financed with recourse we pursue the seller for you. If a buyer does not pay and there is no recourse, or recourse is not recovered, the loss is yours, apart from cases of fraud or untrue warranties by the seller, where the seller must repurchase."],
      [{ b: "Our fee. " }, "We keep the processing fee and a share of the discount and penal charges collected, as published in our fee schedule. The rest of what is collected comes back to your funds."],
      [{ b: "Due diligence. " }, "You may be asked for information we need to meet anti-money-laundering and sanctions rules. We may refuse or reverse a transaction that does not meet them."],
      [{ b: "Data and statements. " }, "We share information about you with registries, regulators and, where the law requires, others. Your statement and portfolio are available in your account."],
      [{ b: "Ending. " }, "Either of us may end this by notice. Deals already funded continue until they are repaid."],
      [{ b: "Law. " }, "[Governing law and forum to be completed by counsel for each country.]"],
    ] },
  ]);
}

/** Terms for a buyer-led supplier finance programme: accepted by the buyer when it applies and by each supplier when it joins. */
export function programmeTerms(): Doc {
  return doc("Supplier Finance Programme Terms", [
    { h: "Supplier finance programme terms" },
    { p: [`Version ${PROGRAMME_TERMS_VERSION}. Draft: to be reviewed by counsel in each country before use.`] },
    { ol: [
      [{ b: "The programme. " }, "A buyer's approved supplier invoices can be financed at a price based on the buyer's credit, up to the limit we set. Suppliers choose whether to join and whether to finance each invoice."],
      [{ b: "The buyer's payment promise. " }, "When the buyer confirms an invoice, it undertakes to pay it in full on the due date, without set-off, counterclaim or deduction, to the account named in the notice of assignment. This undertaking is for the benefit of whoever finances the invoice."],
      [{ b: "Assignment. " }, "The buyer agrees that its suppliers may assign confirmed invoices to financiers, and waives any restriction on assignment in its contracts with them."],
      [{ b: "Limit and price. " }, "We set the programme limit, advance rate and yearly discount, and may pause the programme or change them for new invoices. Invoices already financed keep their price."],
      [{ b: "Information. " }, "The buyer tells us promptly of any dispute, credit note or change in an invoice, and lets us verify invoices with it."],
      [{ b: "Suppliers. " }, "A supplier in the programme still passes our checks on each invoice: verification, fraud screening and approval. Joining does not oblige it to finance any invoice."],
      [{ b: "Law. " }, "[Governing law and forum to be completed by counsel for each country.]"],
    ] },
  ]);
}
