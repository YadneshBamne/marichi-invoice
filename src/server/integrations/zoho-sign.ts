// Real e-signature through Zoho Sign. Needs a refresh token with ZohoSign.documents.CREATE and ZohoSign.documents.READ (see the report / DEPLOY notes).
// Docs used:
//   Create document (POST /requests, multipart file + data): https://www.zoho.com/sign/api/document-managment/create-document.html
//   Send for signature (POST /requests/{id}/submit, form field data): https://www.zoho.com/sign/api/document-managment/send-document-for-signature.html
//   Signature field shape and "every non-VIEW action needs a field": https://www.zoho.com/sign/api/use-cases/sending-a-document-for-signature.html
//   Find requests by name (GET /requests, page_context.search_columns): https://www.zoho.com/sign/api/document-managment/get-document-list.html
//   Scopes: https://www.zoho.com/sign/api/oauth.html   Token and API hosts (.com): https://www.zoho.com/sign/api/getting-started.html
//   Webhook events and payload: https://help.zoho.com/portal/en/kb/zoho-sign/admin-guide/webhooks/articles/webhooks-management
//   Webhook HMAC header: https://help.zoho.com/portal/en/kb/zoho-sign/admin-guide/webhooks/articles/securing-zoho-sign-webhooks-with-hmac-authentication
import { createHmac, timingSafeEqual } from "node:crypto";
import { quoteMoney, requestJson } from "../erp/connectors/types";
import type { EsignPort } from "./gateway";

export type ZohoSignConfig = {
  clientId: string; clientSecret: string; refreshToken: string; dc: "in" | "com" | "eu";
  readDocument?: (ref: string) => Promise<{ bytes: Buffer }>; fetch?: typeof fetch;
};

type Action = { action_id?: string; recipient_name?: string; recipient_email?: string };
type Req = { request_id?: string; request_name?: string; request_status?: string; document_ids?: { document_id?: string; total_pages?: number }[]; actions?: Action[] };

// Zoho ids are 18-digit numbers: quoted before JSON.parse so they never pass through a float.
const IDS = ["request_id", "document_id", "action_id"];
// Zoho answers {"code":0,"status":"success"} on success; failures have another status and a message. The token endpoint answers {"error":"..."}.
const errorOf = (b: Record<string, unknown>) =>
  typeof b.error === "string" ? b.error
  : typeof b.status === "string" && b.status !== "success" ? `${typeof b.message === "string" ? b.message : "error"} (code ${b.code})` : undefined;

export function zohoSignEsign(cfg: ZohoSignConfig): EsignPort {
  const f = cfg.fetch ?? fetch;
  const read = cfg.readDocument ?? ((ref: string) => import("../vault").then((v) => v.readDocument(ref)));
  // UNVERIFIED: accounts.zoho.<dc> and sign.zoho.<dc> for in/eu. The docs show only accounts.zoho.com and sign.zoho.com; the others follow Zoho's usual pattern.
  const accounts = `https://accounts.zoho.${cfg.dc}`;
  const api = `https://sign.zoho.${cfg.dc}/api/v1`;
  const call = async (path: string, init: RequestInit) =>
    requestJson(f, "Zoho Sign", `${api}${path}`, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Zoho-oauthtoken ${await accessToken()}` } }, IDS, errorOf);

  // Access tokens last an hour; reuse one until a minute before it ends.
  // ponytail: no shared promise, so two parallel first calls refresh twice (harmless); the worker calls one at a time.
  let cached: { token: string; until: number } | undefined;
  const accessToken = async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    // UNVERIFIED: the docs show token parameters in the query string; sent as a form body here (same as the Zoho Books connector).
    const b = await requestJson(f, "Zoho", `${accounts}/oauth/v2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: "refresh_token" }).toString(),
    }, IDS, errorOf);
    if (typeof b.access_token !== "string") throw new Error("Zoho did not return an access token; authorise the refresh token again");
    cached = { token: b.access_token, until: Date.now() + ((Number(b.expires_in) || 3600) - 60) * 1000 };
    return b.access_token;
  };

  // Creating only makes a draft; this sends it. Every signing action needs a field, so the signature box goes on the last page.
  const submit = async (r: Req) => {
    const action = r.actions?.[0], doc = r.document_ids?.[0];
    if (!r.request_id || !action?.action_id || !doc?.document_id) throw new Error("e-sign provider returned a request without a signer or document");
    await call(`/requests/${r.request_id}/submit`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ data: JSON.stringify({ requests: { actions: [{
        action_id: action.action_id, action_type: "SIGN", recipient_name: action.recipient_name, recipient_email: action.recipient_email, verify_recipient: false,
        fields: [{
          document_id: doc.document_id, field_name: "Signature", field_label: "Signature", field_type_name: "Signature", field_category: "image", is_mandatory: true,
          // UNVERIFIED: page_no is zero-based (every doc example uses 0), and x/y are points from the top-left. Coordinates are a guess for A4: check a real signed PDF.
          page_no: Math.max(0, (doc.total_pages ?? 1) - 1), x_coord: 40, y_coord: 730, abs_width: 200, abs_height: 40,
        }],
      }] } }) }).toString(),
    });
  };

  return {
    async request(p) {
      // Idempotency: the key is the request's name, and we look it up before creating. Zoho has no idempotency header.
      // Verified from the docs: GET /requests accepts search_columns.request_name and returns request_id, request_status, document_ids and actions per request.
      // UNVERIFIED: the docs show `data` as a form parameter on a GET; it is sent in the query string here. The search may be a "contains" match, so the name is compared exactly.
      const name = `Marichi agreement ${p.idempotencyKey}`;
      const q = JSON.stringify({ page_context: { row_count: 20, start_index: 1, search_columns: { request_name: name }, sort_column: "created_time", sort_order: "DESC" } });
      const found = await call(`/requests?${new URLSearchParams({ data: q })}`, { headers: { accept: "application/json" } });
      const old = (Array.isArray(found.requests) ? found.requests as Req[] : []).find((r) => r.request_name === name);
      if (old) {
        // UNVERIFIED: a request that was created but never submitted shows request_status "draft" (the create example shows it). Finish sending it.
        if (old.request_status === "draft") await submit(old);
        if (!old.request_id) throw new Error("e-sign provider returned no request id");
        return { requestId: old.request_id };
      }

      const { bytes } = await read(p.documentRef);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), `${p.idempotencyKey}.pdf`);
      form.append("data", JSON.stringify({ requests: {
        request_name: name, is_sequential: true,
        actions: [{ action_type: "SIGN", recipient_name: p.signer.split("@")[0], recipient_email: p.signer, verify_recipient: false }], // the request carries only an email, so the name is its first part
      } }));
      const made = await call("/requests", { method: "POST", headers: { accept: "application/json" }, body: form }); // content-type (with boundary) is set by fetch
      const r = made.requests as Req | undefined;
      if (!r?.request_id) throw new Error("e-sign provider returned no request id");
      await submit(r); // if this fails the worker retries and the lookup above finds the draft
      return { requestId: r.request_id };
    },
  };
}

type Headers_ = Headers | Record<string, string | null | undefined>;

/**
 * Check a Zoho Sign webhook and turn it into what completeSignature takes. Throws when the signature is wrong.
 * Returns null for events we don't act on (still answer 200).
 */
export type ZohoSignEvent = { requestId: string; outcome: "signed" | "failed"; signer?: { email?: string; ip?: string; userAgent?: string } };
export function parseZohoSignWebhook(rawBody: string, headers: Headers_, secret: string): ZohoSignEvent | null {
  const sum = headers instanceof Headers ? headers.get("x-zs-webhook-signature")
    : Object.entries(headers).find(([k]) => k.toLowerCase() === "x-zs-webhook-signature")?.[1] ?? null;
  // Base64 of HMAC-SHA256 over the raw body, keyed with the webhook's secret, sent in X-ZS-WEBHOOK-SIGNATURE.
  // UNVERIFIED: Zoho's article writes the formula as HMAC(payload+secret) but its Java sample (and normal practice) keys with the secret; we follow the sample.
  // Neither reading reproduces the article's own test vector (secret "thisisthesamplekeyfortestingpurposes"), so test with a real webhook before go-live.
  const want = createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(sum ?? "", "base64");
  if (!secret || !sum || got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("invalid webhook signature");

  const j = JSON.parse(quoteMoney(rawBody, ["request_id"])) as { notifications?: { operation_type?: string; performed_by_email?: string; ip_address?: string }; requests?: { request_id?: string } };
  const op = j.notifications?.operation_type;
  const outcome = op === "RequestCompleted" ? "signed" : op === "RequestRejected" || op === "RequestRecalled" || op === "RequestExpired" ? "failed" : null;
  const id = j.requests?.request_id;
  if (!outcome || !id) return null;
  // On completion the actor is the last signer; the payload has no browser string. UNVERIFIED: that performed_by_email / ip_address are filled on RequestCompleted.
  const n = j.notifications;
  return { requestId: String(id), outcome, signer: outcome === "signed" && n?.performed_by_email ? { email: n.performed_by_email, ip: n.ip_address } : undefined };
}
