// Real adapter for Razorpay eMandate (e-NACH, India), written from the public docs. Covers MandatePort: register, debit, cancel.
// Test-mode keys (rzp_test_...) use the same host as live keys. Nothing here has been run against the real service.
// Docs used:
//   Registration link: https://razorpay.com/docs/partners/aggregators/partner-auth/recurring-payments/emandate/registration  (POST /subscription_registration/auth_links)
//   Subsequent debit:  https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-subsequent-payments  (POST /orders, POST /payments/create/recurring)
//   Auto debit:        https://razorpay.com/docs/payments/payment-gateway/s2s-integration/recurring-payments/emandate/auto-debit
//   Tokens:            https://razorpay.com/docs/api/payments/recurring-payments/emandate/tokens  (GET /customers/:id/tokens, DELETE /customers/:id/tokens/:token_id)
//   Fetch orders:      https://razorpay.com/docs/api/orders/fetch-all/  (GET /orders?receipt=)
//   Order payments:    https://razorpay.com/docs/api/orders/fetch-payments/  (GET /orders/:id/payments)
//   Webhook payloads:  https://razorpay.com/docs/api/payments/recurring-payments/webhooks/  and  https://razorpay.com/docs/webhooks/payloads/payments/
//   Signature:         https://razorpay.com/docs/webhooks/validate-test/
//
// How the pieces fit:
//   register: one call creates the authorisation link AND the customer. mandateRef = "<customer_id>:<link id>". The buyer opens the link (see registrationLink) and authorises at their bank.
//   debit:    a fresh order per debit (receipt = hash of the idempotency key), then a recurring payment on the customer's confirmed token.
//   cancel:   deletes the customer's tokens (or cancels the link if the buyer never authorised).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MandatePort } from "./gateway";

export type RazorpayMandateConfig = {
  keyId: string; keySecret: string; fetch?: typeof fetch;
  /** Used when the caller does not pass an email and phone for the buyer. UNVERIFIED: Razorpay accepts placeholders. */
  contact?: { email: string; phone: string };
  authType?: "netbanking" | "debitcard" | "aadhaar";
};

const BASE = "https://api.razorpay.com/v1";
const TEN_YEARS_S = 10 * 365 * 86_400;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Reply = { ok: boolean; status: number; json: Json };

async function call(cfg: RazorpayMandateConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Reply> {
  const f = cfg.fetch ?? fetch;
  const res = await f(`${BASE}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64")}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000), // the gateway's own timeout is shorter; this only stops a hung socket
  });
  const text = await res.text();
  let json: Json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json: json ?? {} };
}

const problem = (what: string, r: Reply) =>
  new Error(`razorpay ${what} failed (${r.status}${r.json.error?.code ? ` ${r.json.error.code}` : ""}): ${String(r.json.error?.description ?? "").slice(0, 200)}`);

// Receipts are our handle on a request, so the retry can find it. UNVERIFIED: receipt is limited to 40 characters.
const receipt = (key: string) => `MV${createHash("sha256").update(key).digest("hex").slice(0, 30)}`;
const paise = (n: bigint) => Number(n); // paise fit a JSON number for any realistic amount; Razorpay wants an integer

function split(mandateRef: string) {
  const [customerId, linkId] = mandateRef.split(":");
  if (!customerId || !linkId) throw new Error(`razorpay mandate reference is malformed: ${mandateRef}`);
  return { customerId, linkId };
}

type Status = "processing" | "succeeded" | "failed";
function mapPayment(p: Json): { status: Status; utr?: string; reason?: string } {
  const s = String(p.status ?? "");
  const utr = p.acquirer_data?.rrn ?? p.acquirer_data?.bank_transaction_id ?? undefined; // UNVERIFIED: eMandate debits may carry no bank reference here
  if (s === "captured" || s === "refunded") return { status: "succeeded", ...(utr && { utr: String(utr) }) };
  if (s === "failed") return { status: "failed", reason: String(p.error_description ?? p.error_reason ?? p.error_code ?? "debit failed").slice(0, 200) };
  return { status: "processing" }; // created, authorized: the bank has not settled it yet
}

/** The customer's confirmed e-mandate token, newest first. */
async function confirmedToken(cfg: RazorpayMandateConfig, customerId: string) {
  const r = await call(cfg, "GET", `/customers/${encodeURIComponent(customerId)}/tokens`);
  if (!r.ok) throw problem("token lookup", r);
  const items: Json[] = (r.json.items ?? []).filter((t: Json) => t.method === "emandate");
  return { items, token: items.filter((t) => t.recurring_details?.status === "confirmed").sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0] as Json | undefined };
}

/** The Razorpay keys from the environment, or null when this deployment has none. */
export const razorpayConfigFromEnv = (env: Record<string, string | undefined> = process.env): RazorpayMandateConfig | null =>
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET } : null;

export function razorpayMandates(cfg: RazorpayMandateConfig): MandatePort {
  const fallback = cfg.contact ?? { email: "autopay@marichisolutions.com", phone: "9999999999" };
  return {
    async register(p) {
      const rc = receipt(p.idempotencyKey);
      // Idempotent retry: if a link with this receipt exists, return it instead of making a second one.
      // UNVERIFIED: GET /invoices?receipt= is the "fetch multiple invoices" call; its page could not be read.
      const seen = await call(cfg, "GET", `/invoices?receipt=${rc}`).catch(() => undefined);
      let link: Json = seen?.ok ? (seen.json.items ?? []).find((i: Json) => i.receipt === rc) : undefined;
      if (!link) {
        const extra = p as { email?: string; phone?: string };
        const r = await call(cfg, "POST", "/subscription_registration/auth_links", {
          customer: { name: p.holderName.slice(0, 50), email: extra.email ?? fallback.email, contact: extra.phone ?? fallback.phone }, // creates the customer too
          type: "link",
          amount: 0, // must be 0 for e-mandate
          currency: "INR",
          description: "Auto-pay authorisation",
          subscription_registration: {
            method: "emandate",
            auth_type: cfg.authType ?? "netbanking",
            expire_at: Math.floor(Date.now() / 1000) + TEN_YEARS_S, // UNVERIFIED: the longest expiry banks accept
            max_amount: paise(p.maxAmount),
            bank_account: { beneficiary_name: p.holderName.slice(0, 100), account_number: p.accountNumber, account_type: "savings", ifsc_code: p.ifsc }, // UNVERIFIED: the port has no account type, so savings
          },
          receipt: rc,
          sms_notify: false, email_notify: false, // the platform shows the link itself
          notes: { idempotency_key: p.idempotencyKey },
        });
        // Razorpay refused the details (bad IFSC, account number...): report it as rejected. The caller needs some reference to store, so use the receipt.
        if (r.status === 400) return { mandateRef: `rejected:${rc}`, status: "rejected" as const, reason: String(r.json.error?.description ?? "rejected").slice(0, 200) };
        if (!r.ok) throw problem("registration link", r);
        link = r.json;
      }
      if (!link.id || !link.customer_id) throw new Error("razorpay registration link response had no id or customer_id");
      const mandateRef = `${link.customer_id}:${link.id}`;
      if (link.status === "expired" || link.status === "cancelled") return { mandateRef, status: "rejected", reason: `authorisation link ${link.status}` };
      return { mandateRef, status: "pending" }; // active only once the bank confirms: webhook token.confirmed, or mandateStatus()
    },

    async debit(p) {
      const { customerId } = split(p.mandateRef);
      const rc = receipt(p.idempotencyKey);

      // Razorpay documents no idempotency header for orders or payments (UNVERIFIED), so the receipt is the key: look before creating anything.
      const found = await call(cfg, "GET", `/orders?receipt=${rc}`);
      if (!found.ok) throw problem("order lookup", found);
      let orderId: string | undefined = (found.json.items ?? []).find((o: Json) => o.receipt === rc)?.id;
      if (orderId) {
        const pays = await call(cfg, "GET", `/orders/${encodeURIComponent(orderId)}/payments`);
        if (!pays.ok) throw problem("payment lookup", pays);
        const items: Json[] = pays.json.items ?? [];
        // A live or successful payment wins; a failed one is final for this key (the caller uses a new key for the next attempt).
        const hit = items.find((x) => x.status !== "failed") ?? items[0];
        if (hit) return { debitRef: String(hit.id), ...mapPayment(hit) };
      } else {
        const o = await call(cfg, "POST", "/orders", { amount: paise(p.amount), currency: "INR", payment_capture: true, receipt: rc, notes: { idempotency_key: p.idempotencyKey, reference: p.reference.slice(0, 200) } });
        if (!o.ok) throw problem("order", o);
        orderId = String(o.json.id);
      }

      const { token } = await confirmedToken(cfg, customerId);
      if (!token) throw new Error("razorpay mandate has no confirmed token yet");
      // UNVERIFIED: GET /customers/:id was not documented on the pages read; email and contact are required on the debit.
      const cust = await call(cfg, "GET", `/customers/${encodeURIComponent(customerId)}`).catch(() => undefined);
      const r = await call(cfg, "POST", "/payments/create/recurring", {
        email: cust?.json.email ?? fallback.email, contact: cust?.json.contact ?? fallback.phone,
        amount: paise(p.amount), currency: "INR", order_id: orderId, customer_id: customerId, token: token.id, recurring: true,
        description: p.reference.slice(0, 200), notes: { idempotency_key: p.idempotencyKey },
      });
      // Razorpay refused the request itself (over the mandate maximum, bad token): no money moved, so it is a failed debit, not an outage.
      if (r.status === 400) return { debitRef: orderId, status: "failed", reason: String(r.json.error?.description ?? "rejected").slice(0, 200) };
      if (!r.ok) throw problem("recurring payment", r);
      const id = String(r.json.razorpay_payment_id ?? "");
      if (!id) throw new Error("razorpay recurring payment response had no payment id");
      return { debitRef: id, status: "processing" }; // settles later: webhook payment.captured / payment.failed
    },

    async cancel(mandateRef) {
      const { customerId, linkId } = split(mandateRef);
      const { items } = await confirmedToken(cfg, customerId);
      const live = items.filter((t) => ["initiated", "confirmed", "paused"].includes(t.recurring_details?.status));
      for (const t of live) {
        const r = await call(cfg, "DELETE", `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(t.id)}`);
        if (!r.ok || r.json.deleted === false) throw problem("token delete", r);
      }
      if (!live.length) {
        // Never authorised: close the link so it cannot be used later. UNVERIFIED: POST /invoices/:id/cancel (only works while the link is `issued`).
        const r = await call(cfg, "POST", `/invoices/${encodeURIComponent(linkId)}/cancel`);
        if (!r.ok && r.status !== 400) throw problem("link cancel", r); // 400: already paid, expired or cancelled
      }
    },
  };
}

/** The page the buyer opens to authorise the mandate at their bank. Show it after register, until the mandate turns active. */
export async function registrationLink(cfg: RazorpayMandateConfig, mandateRef: string): Promise<string> {
  const { linkId } = split(mandateRef);
  const r = await call(cfg, "GET", `/invoices/${encodeURIComponent(linkId)}`); // UNVERIFIED: fetch-invoice call; short_url is in the create response
  if (!r.ok) throw problem("link lookup", r);
  if (!r.json.short_url) throw new Error("razorpay link has no short_url");
  return String(r.json.short_url);
}

/** Where the mandate stands now, read from Razorpay. Use it to settle pending mandates after any token webhook (those carry the token id, not our reference). */
export async function mandateStatus(cfg: RazorpayMandateConfig, mandateRef: string): Promise<{ status: "pending" | "active" | "rejected" | "cancelled"; reason?: string }> {
  const { items } = await confirmedToken(cfg, split(mandateRef).customerId);
  const by = (s: string) => items.find((t) => t.recurring_details?.status === s);
  if (by("confirmed")) return { status: "active" };
  const bad = by("rejected");
  if (bad) return { status: "rejected", reason: String(bad.recurring_details.failure_reason ?? "rejected by bank").slice(0, 200) };
  if (by("cancelled")) return { status: "cancelled" };
  return { status: "pending" };
}

export type RazorpayMandateEvent =
  | { type: "token"; tokenId: string; status: "active" | "rejected" | "cancelled"; reason?: string }
  | { type: "debit"; idempotencyKey: string; status: "succeeded" | "failed"; providerRef: string; utr?: string; reason?: string };

/**
 * Checks X-Razorpay-Signature (HMAC-SHA256 hex of the raw body, with the webhook secret) and maps the event.
 * Throws on a bad signature. Returns null for events we do not handle, and for payments that are not our debits.
 */
export function parseRazorpayMandateWebhook(rawBody: string, signatureHeader: string | null, secret: string): RazorpayMandateEvent | null {
  if (!signatureHeader || !secret) throw new Error("invalid signature");
  const want = createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(signatureHeader, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("invalid signature");

  let b: Json;
  try { b = JSON.parse(rawBody); } catch { throw new Error("webhook body is not JSON"); }
  const event = String(b?.event ?? "");

  if (event.startsWith("token.")) {
    const t = b.payload?.token?.entity;
    const status = { "token.confirmed": "active", "token.rejected": "rejected", "token.cancelled": "cancelled" }[event] as "active" | "rejected" | "cancelled" | undefined;
    if (!status || !t?.id) return null;
    const reason = t.recurring_details?.failure_reason;
    return { type: "token", tokenId: String(t.id), status, ...(status === "rejected" && { reason: String(reason ?? "rejected by bank").slice(0, 200) }) };
  }
  if (event === "payment.captured" || event === "payment.failed") {
    const pay = b.payload?.payment?.entity;
    const key = pay?.notes?.idempotency_key; // we put it in the notes of every debit; Razorpay sends [] when notes are empty
    if (!pay?.id || typeof key !== "string" || !key) return null;
    const ok = event === "payment.captured";
    const utr = pay.acquirer_data?.rrn ?? pay.acquirer_data?.bank_transaction_id;
    return {
      type: "debit", idempotencyKey: key, status: ok ? "succeeded" : "failed", providerRef: String(pay.id),
      ...(ok && utr && { utr: String(utr) }),
      ...(!ok && { reason: String(pay.error_description ?? pay.error_reason ?? pay.error_code ?? "debit failed").slice(0, 200) }),
    };
  }
  return null;
}
