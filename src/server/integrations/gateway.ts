// Central Integration Gateway (PRD 12.1). Modules call these ports, never a vendor directly.
// Swap mock -> real by adding an adapter and changing `adapters` below; no module code changes.
import { mock } from "./mock";
import { harden } from "./harden";
import { anthropicOcr } from "./anthropic-ocr";
import { resendNotify } from "./resend-email";

export interface KycPort {
  verifyPan(pan: string, name: string): Promise<{ valid: boolean; nameMatch: boolean }>;
  verifyBankAccount(acct: string, ifsc: string, name: string): Promise<{ exists: boolean; nameMatch: boolean }>;
  screenAml(name: string): Promise<{ score: number; hit: boolean }>; // fail-closed: throw => block approval
}
export type IrnClaim = { amount: bigint; buyerGstin: string; sellerGstin: string; date: string };
export interface IrnPort {
  /** Returns the registry's canonical record, or null if the IRN doesn't exist. `mockHint` is ignored by real adapters. */
  getIrn(irn: string, mockHint?: IrnClaim): Promise<(IrnClaim & { cancelled: boolean }) | null>;
}
export interface BureauPort {
  pull(pan: string, consentRef: string): Promise<{ score: number | null; noHit: boolean }>;
}
export type Rail = "IMPS" | "NEFT" | "RTGS";
export interface PaymentsPort {
  /** Idempotent on `idempotencyKey`: a retry must never move money twice. */
  payout(p: { idempotencyKey: string; amount: bigint; ifsc: string; account: string; rail: Rail }): Promise<{ bankRef: string; status: "processing" | "succeeded" | "failed"; reason?: string }>;
  payoutStatus(bankRef: string): Promise<"processing" | "succeeded" | "failed">;
  /** Dedicated collection account for one invoice; idempotent on the key. Buyer credits to it reconcile automatically. */
  issueVirtualAccount(p: { idempotencyKey: string }): Promise<{ accountNumber: string; ifsc: string }>;
}
export interface EsignPort {
  request(p: { idempotencyKey: string; documentRef: string; signer: string }): Promise<{ requestId: string }>;
}
export type Channel = "email" | "sms";
export interface NotifyPort {
  /** `subject`/`body` are already rendered. SMS providers in India need `dltTemplateId` (TRAI DLT). Throw on failure so the queue retries. */
  send(p: { channel: Channel; to: string; template: string; data: Record<string, string>; subject?: string; body: string; dltTemplateId?: string }): Promise<{ providerRef?: string } | void>;
}

export type StatementLine = { reference: string; direction: "credit" | "debit"; amount: bigint; narration?: string };
export interface StatementPort {
  /** Escrow account statement for one business date (YYYY-MM-DD), from the bank feed (API or MT940/CAMT.053 file). */
  fetch(date: string): Promise<StatementLine[]>;
}

export interface MandatePort {
  /** Register an e-NACH mandate. Usually comes back `pending` until the account holder authorises it at their bank. Idempotent on the key. */
  register(p: { idempotencyKey: string; holderName: string; accountNumber: string; ifsc: string; maxAmount: bigint }): Promise<{ mandateRef: string; status: "pending" | "active" | "rejected"; reason?: string }>;
  /** Present one debit against an active mandate. Idempotent on the key: a retry must never debit twice. */
  debit(p: { idempotencyKey: string; mandateRef: string; amount: bigint; reference: string }): Promise<{ debitRef: string; status: "processing" | "succeeded" | "failed"; utr?: string; reason?: string }>;
  cancel(mandateRef: string): Promise<void>;
}

export type OcrFields = {
  invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null; totalAmount: string | null; currency: string | null;
  sellerName: string | null; sellerGstin: string | null; buyerName: string | null; buyerGstin: string | null; irn: string | null; poReference: string | null;
};
export interface OcrPort {
  /** Read an invoice document. Values are suggestions to pre-fill a form: the seller confirms them. `simulated` = sandbox data, not a real reading. */
  extractInvoice(p: { bytes: Uint8Array; mime: string }): Promise<{ fields: OcrFields; simulated: boolean }>;
}

export type Adapters = {
  kyc: KycPort; irn: IrnPort; bureau: BureauPort; payments: PaymentsPort; esign: EsignPort; notify: NotifyPort; statements: StatementPort; mandates: MandatePort; ocr: OcrPort;
};

// ponytail: mock only; add real adapters per provider when licences exist, select via INTEGRATIONS_MODE.
// Invoice reading is not a licensed service, so it goes live as soon as an Anthropic key exists, independent of INTEGRATIONS_MODE.
const ocr = process.env.ANTHROPIC_API_KEY && process.env.OCR_PROVIDER !== "mock" ? anthropicOcr() : mock.ocr;
// Email goes out for real as soon as Resend is configured; SMS stays simulated until a provider and DLT registration exist.
const notify = process.env.RESEND_API_KEY && process.env.MAIL_FROM ? resendNotify(mock.notify, { apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM }) : mock.notify;
export const gateway: Adapters = harden({ ...mock, ocr, notify });
