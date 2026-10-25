// Real adapter for Cashfree (India), written from the public docs. Covers KycPort (PAN and bank account checks) and PaymentsPort (payouts, virtual accounts).
// Cashfree has no AML screening, so screenAml goes to the fallback port. Sandbox is the default base URL; set env: "production" to go live.
// Docs used:
//   PAN:            https://www.cashfree.com/docs/api-reference/vrs/v2/pan/verify-pan-sync
//   Bank account:   https://www.cashfree.com/docs/api-reference/vrs/v2/bav-v2/bank-account-verification-sync-v2
//   Payout:         https://www.cashfree.com/docs/api-reference/payouts/v2/transfers-v2/standard-transfer-v2
//   Payout status:  https://www.cashfree.com/docs/api-reference/payouts/v2/transfers-v2/get-transfer-status-v2
//   Virtual acct:   https://www.cashfree.com/docs/api-reference/payments/latest/pgvba/create-vba  (and .../pgvba/get-vba)
//   Credit webhook: https://www.cashfree.com/docs/payments/vba/webhooks
//   Signature:      https://www.cashfree.com/docs/payments/online/webhooks/signature-verification
// Cashfree issues separate keys per product (Secure ID, Payouts, Payment Gateway): pass the right pair to each factory.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { KycPort, PaymentsPort, Rail } from "./gateway";
import { rupeesToPaise, toDecimal } from "../../lib/money";

type Creds = { clientId: string; clientSecret: string };
export type CashfreeConfig = Creds & { env: "sandbox" | "production"; fetch?: typeof fetch };

const BASE = { sandbox: "https://sandbox.cashfree.com", production: "https://api.cashfree.com" };
const PAYOUT_VERSION = "2024-01-01";
// UNVERIFIED: the create-VBA page lists this odd timestamp as the only allowed value while describing the format as YYYY-MM-DD. Confirm in the sandbox.
const VBA_VERSION = "2024-07-10T00:00:00.000Z";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Reply = { ok: boolean; status: number; json: Json };

async function call(cfg: CashfreeConfig, c: Creds, method: "GET" | "POST", path: string, extra: Record<string, string> = {}, body?: string): Promise<Reply> {
  const f = cfg.fetch ?? fetch;
  const res = await f(`${BASE[cfg.env]}${path}`, {
    method,
    headers: { "x-client-id": c.clientId, "x-client-secret": c.clientSecret, "content-type": "application/json", ...extra },
    body,
    signal: AbortSignal.timeout(60_000), // the gateway's own timeout is shorter; this only stops a hung socket
  });
  const text = await res.text();
  let json: Json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json: json ?? {} };
}

const problem = (what: string, r: Reply) =>
  new Error(`cashfree ${what} failed (${r.status}${r.json.code ? ` ${r.json.code}` : ""}): ${String(r.json.message ?? "").slice(0, 200)}`);

// Name checks only allow letters, digits, space and . - / & (PAN and bank docs). Anything else is turned into a space.
const cleanName = (n: string) => n.replace(/[^A-Za-z0-9 .\-/&]/g, " ").replace(/\s+/g, " ").trim();
// UNVERIFIED: which name_match_result values count as a match is our policy, not Cashfree's.
const MATCH = new Set(["DIRECT_MATCH", "GOOD_PARTIAL_MATCH"]);

export function cashfreeKyc(fallback: KycPort, cfg: CashfreeConfig): KycPort {
  return {
    async verifyTaxId(taxId, name) {
      const n = cleanName(name);
      const r = await call(cfg, cfg, "POST", "/verification/pan", {}, JSON.stringify({ pan: taxId.toUpperCase(), ...(n && { name: n }) }));
      if (r.status === 400 && /^pan_/.test(r.json.code ?? "")) return { valid: false, nameMatch: false }; // malformed PAN
      if (!r.ok) throw problem("PAN check", r); // fail closed: an outage is not "invalid"
      const valid = r.json.valid === true && (r.json.pan_status === undefined || r.json.pan_status === "VALID");
      return { valid, nameMatch: valid && MATCH.has(r.json.name_match_result) };
    },
    async verifyBankAccount(acct, ifsc, name) {
      const n = cleanName(name);
      const r = await call(cfg, cfg, "POST", "/verification/bank-account/sync", {}, JSON.stringify({ bank_account: acct, ifsc, ...(n && { name: n }) }));
      if (r.status === 400 && /^(bank_account|ifsc)_/.test(r.json.code ?? "")) return { exists: false, nameMatch: false };
      if (!r.ok) throw problem("bank account check", r); // 422 bank-side errors (imps_mode_fail, npci_unavailable...) are inconclusive, so they throw
      const exists = r.json.account_status === "VALID";
      return { exists, nameMatch: exists && MATCH.has(r.json.name_match_result) };
    },
    screenAml: (name) => fallback.screenAml(name), // Cashfree has no AML product; the fallback must itself fail closed
  };
}

export type CashfreePaymentsConfig = CashfreeConfig & {
  /** Payment Gateway keys for virtual accounts, if they differ from the Payouts keys above. */
  collect?: Creds;
  /** Required by Cashfree on every virtual account. UNVERIFIED: placeholders are accepted. */
  vaContact?: { name: string; email: string; phone: string };
};

// Cashfree limits ids to letters, digits and underscore (transfer, max 40) or uppercase letters and digits (virtual account), so the key is hashed.
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const transferId = (key: string) => `MV_${digest(key).slice(0, 36)}`;
const vaId = (key: string) => `MV${digest(key).slice(0, 30).toUpperCase()}`; // UNVERIFIED: maximum length of virtual_account_id

const MODE: Partial<Record<Rail, string>> = { IMPS: "imps", NEFT: "neft", RTGS: "rtgs" };

type Status = "processing" | "succeeded" | "failed";
function mapStatus(j: Json): { status: Status; reason?: string } {
  const s = String(j.status ?? "");
  if (s === "SUCCESS") return { status: "succeeded" };
  // REVERSED: the bank returned the money, so it is a failure for us.
  if (["FAILED", "REJECTED", "REVERSED", "MANUALLY_REJECTED"].includes(s)) {
    // UNVERIFIED: status_code / status_description appear in the doc examples but not in the response schema.
    return { status: "failed", reason: String(j.status_description ?? j.status_code ?? s).slice(0, 200) };
  }
  return { status: "processing" }; // RECEIVED, APPROVAL_PENDING, VALIDATION_PENDING, PENDING, QUEUED
}

export function cashfreePayments(fallback: PaymentsPort, cfg: CashfreePaymentsConfig): PaymentsPort {
  void fallback; // every payments method is implemented; kept so both factories have the same shape
  const payoutHeaders = { "x-api-version": PAYOUT_VERSION };
  const lookup = (id: string) => call(cfg, cfg, "GET", `/payout/transfers?transfer_id=${encodeURIComponent(id)}`, payoutHeaders);
  const collect = cfg.collect ?? cfg;
  const contact = cfg.vaContact ?? { name: "Marichi Collections", email: "collections@marichisolutions.com", phone: "9999999999" };

  return {
    async payout(p) {
      const mode = MODE[p.rail];
      if (!mode) throw new Error(`cashfree cannot pay by ${p.rail}`);
      const id = transferId(p.idempotencyKey);
      // The amount goes in as an exact decimal literal (the API wants a JSON number); no float is built from paise.
      const body = JSON.stringify({
        transfer_id: id,
        transfer_amount: "@@AMOUNT@@",
        transfer_currency: "INR",
        transfer_mode: mode,
        // UNVERIFIED: the port carries no beneficiary name but Cashfree requires one when there is no beneficiary_id. Callers should pass it as `beneficiaryName`.
        beneficiary_details: {
          beneficiary_name: cleanBeneficiary((p as { beneficiaryName?: string }).beneficiaryName),
          beneficiary_instrument_details: { bank_account_number: p.account, bank_ifsc: p.ifsc },
        },
      }).replace('"@@AMOUNT@@"', toDecimal(p.amount));

      let r: Reply | undefined, err: unknown;
      try { r = await call(cfg, cfg, "POST", "/payout/transfers", payoutHeaders, body); } catch (e) { err = e; }
      if (r?.ok) return { bankRef: id, ...mapStatus(r.json) };

      // Idempotent retry: after a timeout or error the transfer may already exist, so ask before giving up. Never send a second one.
      const seen = await lookup(id).catch(() => undefined);
      if (seen?.ok) return { bankRef: id, ...mapStatus(seen.json) };
      // A 400 means Cashfree refused the request itself, so no money moved and the next rail can be tried.
      if (r?.status === 400) return { bankRef: id, status: "failed", reason: String(r.json.message ?? r.json.code ?? "rejected").slice(0, 200) };
      throw err ?? problem("payout", r!); // anything else is unknown: the caller keeps it processing and retries with the same key
    },
    async payoutStatus(bankRef) {
      const r = await lookup(bankRef);
      if (!r.ok) throw problem("payout status", r);
      return mapStatus(r.json).status;
    },
    async issueVirtualAccount(p) {
      const id = vaId(p.idempotencyKey);
      const vbaHeaders = { "x-api-version": VBA_VERSION };
      const create = await call(cfg, collect, "POST", "/pg/vba", vbaHeaders, JSON.stringify({
        virtual_account_details: { virtual_account_id: id, virtual_account_name: contact.name, virtual_account_email: contact.email, virtual_account_phone: contact.phone },
      }));
      let r = create;
      // UNVERIFIED: the docs show 409 (resource already present) and 422 (idempotency_error) but not that a repeated virtual_account_id returns them. Fetch the existing one.
      if (create.status === 409 || create.status === 422) r = await call(cfg, collect, "GET", `/pg/vba/${encodeURIComponent(id)}`, vbaHeaders);
      if (!r.ok) throw problem("virtual account", r);
      const a = r.json.virtual_bank_accounts?.[0]; // UNVERIFIED: with no bank_codes, which bank's account comes first
      if (!a?.vba_account_number || !a?.vba_ifsc) throw new Error("cashfree virtual account response had no account number");
      return { accountNumber: String(a.vba_account_number), ifsc: String(a.vba_ifsc) };
    },
  };
}

const cleanBeneficiary = (n?: string) => (n ?? "").replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Beneficiary";

/** Cashfree signs `timestamp + rawBody` with HMAC-SHA256 (base64) using the Payment Gateway secret, and sends it in x-webhook-signature / x-webhook-timestamp. */
export function verifyCashfreeWebhookSignature(rawBody: string, timestamp: string | null, signature: string | null, secret: string): boolean {
  if (!timestamp || !signature || !secret) return false;
  // UNVERIFIED: the docs' code joins timestamp and body directly, but their pseudocode shows a dot between them. Confirm with the Dev Studio verifier.
  const want = createHmac("sha256", secret).update(timestamp + rawBody).digest();
  const got = Buffer.from(signature, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Maps a PAYMENT_SUCCESS_WEBHOOK for a virtual-account (vba_transfer) credit to what recordIncomingPayment takes.
 * Returns null for any other event. The older AMOUNT_COLLECTED payload only carries vAccountId, not the account number, so it is not mapped.
 */
export function parseCashfreeCredit(body: unknown): { accountNumber: string; amount: bigint; utr: string; receivedAt: Date } | null {
  const b = body as Json;
  const pay = b?.data?.payment;
  const vba = pay?.payment_method?.vba_transfer;
  if (b?.type !== "PAYMENT_SUCCESS_WEBHOOK" || pay?.payment_status !== "SUCCESS" || !vba) return null;
  const utr = String(vba.utr ?? pay.bank_reference ?? "");
  if (!vba.vaccount_number || !utr) throw new Error("cashfree credit webhook is missing the account number or UTR");
  // UNVERIFIED: payment_amount is a JSON number in the example; its decimal form is assumed to have at most two places.
  return { accountNumber: String(vba.vaccount_number), amount: rupeesToPaise(String(pay.payment_amount)), utr, receivedAt: new Date(pay.payment_time) };
}
