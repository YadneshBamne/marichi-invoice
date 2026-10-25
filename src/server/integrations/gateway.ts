// Central Integration Gateway (PRD 12.1). Modules call these ports, never a vendor directly.
// Swap mock -> real by adding an adapter and changing `adapters` below; no module code changes.
import { mock } from "./mock";
import { harden } from "./harden";
import { anthropicOcr } from "./anthropic-ocr";
import { resendNotify } from "./resend-email";
import { localOcr } from "./ocr/local";
import { cashfreeKyc, cashfreePayments } from "./cashfree";
import { digioEsign } from "./digio";
import { msg91Notify } from "./msg91";

export interface KycPort {
  verifyTaxId(taxId: string, name: string): Promise<{ valid: boolean; nameMatch: boolean }>;
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
export type { Rail } from "../../lib/countries";
import type { Rail } from "../../lib/countries";
export interface PaymentsPort {
  /** Idempotent on `idempotencyKey`: a retry must never move money twice. */
  payout(p: { idempotencyKey: string; amount: bigint; ifsc: string; account: string; rail: Rail; beneficiaryName?: string }): Promise<{ bankRef: string; status: "processing" | "succeeded" | "failed"; reason?: string }>;
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

export interface RegistryPort {
  /** File the assignment of one invoice at the country's registry (CERSAI, PACRA). Idempotent on the key. Throw on failure so the worker retries. */
  file(p: { idempotencyKey: string; registry: string; assignor: string; assignee: string; invoiceNumber: string; amount: bigint }): Promise<{ reference: string }>;
}

export interface FxPort {
  /** Mid-market rate: rupees per one whole unit of `currency`, times 1,000,000 (an integer, so no float ever touches money). */
  rate(currency: string): Promise<{ midMicro: bigint; asOf: string }>;
}

export type OcrFields = {
  invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null; totalAmount: string | null; currency: string | null;
  sellerName: string | null; sellerGstin: string | null; buyerName: string | null; buyerGstin: string | null; irn: string | null; poReference: string | null;
};
export interface OcrPort {
  /** Read an invoice document. Values are suggestions to pre-fill a form: the seller confirms them. `simulated` = sandbox data, not a real reading. */
  extractInvoice(p: { bytes: Uint8Array; mime: string }): Promise<{ fields: OcrFields; simulated: boolean; warnings?: string[] }>;
}

export type Adapters = {
  kyc: KycPort; irn: IrnPort; bureau: BureauPort; payments: PaymentsPort; esign: EsignPort; notify: NotifyPort; statements: StatementPort; mandates: MandatePort; ocr: OcrPort; fx: FxPort; registry: RegistryPort;
};

// ponytail: mock only; add real adapters per provider when licences exist, select via INTEGRATIONS_MODE.
// Invoice reading is not a licensed service, so it is live whatever INTEGRATIONS_MODE says.
// Default is the free open-source reader (pdf.js + Tesseract + rules). OCR_PROVIDER=claude (with a key) uses Claude instead; "mock" is for tests.
const ocrProvider = process.env.OCR_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "claude" : process.env.VITEST ? "mock" : "local");
const ocr = ocrProvider === "claude" && process.env.ANTHROPIC_API_KEY ? anthropicOcr() : ocrProvider === "mock" ? mock.ocr : localOcr();
// Email goes out for real as soon as Resend is configured; SMS stays simulated until a provider and DLT registration exist.
const email = process.env.RESEND_API_KEY && process.env.MAIL_FROM ? resendNotify(mock.notify, { apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM }) : mock.notify;

// Each provider below switches on when its keys are set, and never under tests, so a developer's .env cannot make a test call out.
// All are written from the providers' public documents and have not been run against the real services: see DEPLOY.md section 7.
const env = process.env, live = !env.VITEST;
const sandbox = (name: string) => (env[name] === "production" ? "production" : "sandbox") as "sandbox" | "production";
const notify = live && env.MSG91_AUTH_KEY && env.MSG91_SENDER_ID ? msg91Notify(email, { authKey: env.MSG91_AUTH_KEY, senderId: env.MSG91_SENDER_ID }) : email;
const kyc = live && env.CASHFREE_VERIFY_CLIENT_ID && env.CASHFREE_VERIFY_CLIENT_SECRET
  ? cashfreeKyc(mock.kyc, { clientId: env.CASHFREE_VERIFY_CLIENT_ID, clientSecret: env.CASHFREE_VERIFY_CLIENT_SECRET, env: sandbox("CASHFREE_ENV") }) : mock.kyc;
const payments = live && env.CASHFREE_PAYOUT_CLIENT_ID && env.CASHFREE_PAYOUT_CLIENT_SECRET
  ? cashfreePayments(mock.payments, {
    clientId: env.CASHFREE_PAYOUT_CLIENT_ID, clientSecret: env.CASHFREE_PAYOUT_CLIENT_SECRET, env: sandbox("CASHFREE_ENV"),
    collect: env.CASHFREE_PG_CLIENT_ID && env.CASHFREE_PG_CLIENT_SECRET ? { clientId: env.CASHFREE_PG_CLIENT_ID, clientSecret: env.CASHFREE_PG_CLIENT_SECRET } : undefined,
  }) : mock.payments;
const esign = live && env.DIGIO_CLIENT_ID && env.DIGIO_CLIENT_SECRET ? digioEsign({ clientId: env.DIGIO_CLIENT_ID, clientSecret: env.DIGIO_CLIENT_SECRET, env: sandbox("DIGIO_ENV") }) : mock.esign;
export const gateway: Adapters = harden({ ...mock, ocr, notify, kyc, payments, esign });
