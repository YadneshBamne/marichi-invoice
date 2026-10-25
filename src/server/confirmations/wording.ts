// What a buyer is shown, and agrees to, when it confirms an invoice. The exact text is stored with the confirmation as the
// legal record. THIS WORDING NEEDS REVIEW BY COUNSEL IN EACH COUNTRY before launch (see docs/PLATFORM-GUIDE.md section 9): in India an
// acceptance starts the MSMED Act payment period, and whether the no-set-off undertaking is enforceable depends on how it is made.
//
// Principles taken from the research: an acceptance only binds if it is an unconditional payment undertaking, in a signed (here:
// verified and recorded) writing, that names what is accepted and waives defences and set-off. It must not be buried or implied.

export const ACCEPTANCE_VERSION = "2026-10-v1";

export type WordingInput = { buyer: string; seller: string; invoiceNumber: string; amount: string; dueDate: string };

/** The confirmation, as numbered statements the buyer agrees to by pressing Confirm. */
export function acceptanceText(i: WordingInput): string[] {
  return [
    `I am authorised to give this confirmation for ${i.buyer}.`,
    `The goods or services in invoice ${i.invoiceNumber} from ${i.seller}, for ${i.amount}, were delivered or rendered to ${i.buyer} and accepted.`,
    `The amount is correct and is payable by ${i.buyer} on ${i.dueDate}.`,
    `${i.buyer} will pay the full amount on the due date, without set-off, counterclaim or deduction. If this invoice is financed, ${i.buyer} will pay it to the account named in the notice of assignment it receives. Otherwise it will pay ${i.seller} as usual.`,
    `${i.buyer} agrees that ${i.seller} may assign this receivable to a financier, and waives any restriction on assignment in its contract with ${i.seller}.`,
    `This confirmation is recorded with the date and time, the email address verified for it and the network address it was given from.`,
  ];
}

export const DISPUTE_TEXT = "You are not confirming this invoice. The reason you give is sent to the supplier and to our support team, and any financing of this invoice is paused until it is resolved.";
export const CLARIFY_TEXT = "You are asking a question. The invoice stays open and the supplier is told what you asked. Nothing is confirmed.";
