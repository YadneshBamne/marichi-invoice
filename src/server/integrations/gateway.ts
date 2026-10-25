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
import { localAml } from "../aml/service";
import { nicIrn } from "./nic-irn";
import { razorpayConfigFromEnv, razorpayMandates } from "./razorpay-mandates";
import { zohoSignEsign } from "./zoho-sign";
import { webpushNotify } from "./webpush";
import { whatsappNotify } from "./whatsapp";
import { dropPushEndpoint, lookupPushKeys } from "../notify/push";

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
export type Channel = "email" | "sms" | "whatsapp" | "push";
export interface NotifyPort {
  /**
   * `subject`/`body` are already rendered. SMS providers in India need `dltTemplateId` (TRAI DLT). Throw on failure so the queue retries.
   * `whatsapp`: `to` is the phone number, `body` is a JSON array of the template parameters. `push`: `to` is the subscription endpoint,
   * `subject` is the title and `body` is JSON `{ body, url }`. An error with `permanent: true` is not retried.
   */
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
// Messages: each wrapper handles its own channel and passes the rest on to the one inside it (email -> SMS -> WhatsApp -> browser push).
const sms = live && env.MSG91_AUTH_KEY && env.MSG91_SENDER_ID ? msg91Notify(email, { authKey: env.MSG91_AUTH_KEY, senderId: env.MSG91_SENDER_ID }) : email;
const whatsapp = live && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN ? whatsappNotify(sms, { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, accessToken: env.WHATSAPP_ACCESS_TOKEN, apiVersion: env.WHATSAPP_API_VERSION }) : sms;
const db = () => import("../db/client").then((m) => m.db); // loaded when first needed, so importing the gateway never opens a database connection
const notify = live && env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
  ? webpushNotify(whatsapp, { publicKey: env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT, lookup: async (e) => lookupPushKeys(await db(), e), remove: async (e) => dropPushEndpoint(await db(), e) })
  : whatsapp;
const idChecks = live && env.CASHFREE_VERIFY_CLIENT_ID && env.CASHFREE_VERIFY_CLIENT_SECRET
  ? cashfreeKyc(mock.kyc, { clientId: env.CASHFREE_VERIFY_CLIENT_ID, clientSecret: env.CASHFREE_VERIFY_CLIENT_SECRET, env: sandbox("CASHFREE_ENV") }) : mock.kyc;
// Sanctions screening on the public lists (OFAC, UN, EU), free. Opt in with AML_PROVIDER=local AFTER the lists are loaded (scripts/refresh-sanctions.ts):
// until then it refuses to answer, which blocks approvals by design.
const kyc = live && env.AML_PROVIDER === "local" ? { ...idChecks, screenAml: async (name: string) => localAml(await db()).screenAml(name) } : idChecks;
const payments = live && env.CASHFREE_PAYOUT_CLIENT_ID && env.CASHFREE_PAYOUT_CLIENT_SECRET
  ? cashfreePayments(mock.payments, {
    clientId: env.CASHFREE_PAYOUT_CLIENT_ID, clientSecret: env.CASHFREE_PAYOUT_CLIENT_SECRET, env: sandbox("CASHFREE_ENV"),
    collect: env.CASHFREE_PG_CLIENT_ID && env.CASHFREE_PG_CLIENT_SECRET ? { clientId: env.CASHFREE_PG_CLIENT_ID, clientSecret: env.CASHFREE_PG_CLIENT_SECRET } : undefined,
  }) : mock.payments;
// E-signature: Digio if its keys are set, else Zoho Sign.
const esign = live && env.DIGIO_CLIENT_ID && env.DIGIO_CLIENT_SECRET ? digioEsign({ clientId: env.DIGIO_CLIENT_ID, clientSecret: env.DIGIO_CLIENT_SECRET, env: sandbox("DIGIO_ENV") })
  : live && env.ZOHO_SIGN_CLIENT_ID && env.ZOHO_SIGN_CLIENT_SECRET && env.ZOHO_SIGN_REFRESH_TOKEN
    ? zohoSignEsign({ clientId: env.ZOHO_SIGN_CLIENT_ID, clientSecret: env.ZOHO_SIGN_CLIENT_SECRET, refreshToken: env.ZOHO_SIGN_REFRESH_TOKEN, dc: env.ZOHO_SIGN_DC === "com" || env.ZOHO_SIGN_DC === "eu" ? env.ZOHO_SIGN_DC : "in" })
    : mock.esign;
const razorpay = live ? razorpayConfigFromEnv(env) : null;
const mandates = razorpay ? razorpayMandates(razorpay) : mock.mandates;
// The e-invoice portal's key is a PEM; in an environment file its line breaks are written as \n.
const irn = live && env.NIC_IRP_CLIENT_ID && env.NIC_IRP_CLIENT_SECRET && env.NIC_IRP_GSTIN && env.NIC_IRP_USERNAME && env.NIC_IRP_PASSWORD && env.NIC_IRP_PUBLIC_KEY
  ? nicIrn({ baseUrl: env.NIC_IRP_BASE_URL || undefined, clientId: env.NIC_IRP_CLIENT_ID, clientSecret: env.NIC_IRP_CLIENT_SECRET, gstin: env.NIC_IRP_GSTIN, userName: env.NIC_IRP_USERNAME, password: env.NIC_IRP_PASSWORD, publicKeyPem: env.NIC_IRP_PUBLIC_KEY.replace(/\\n/g, "\n") })
  : mock.irn;
export const gateway: Adapters = harden({ ...mock, ocr, notify, kyc, payments, esign, mandates, irn });
