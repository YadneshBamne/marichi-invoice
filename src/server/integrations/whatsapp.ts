// WhatsApp messages through Meta's WhatsApp Business Cloud API (template messages only: the only kind allowed outside a 24-hour chat).
// Needs WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN (a system user token); webhooks also need WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN.
// Other channels go to the fallback port. Each template in templates.ts must exist and be approved in WhatsApp Manager.
// Docs used (the page paths under /documentation/business-messaging/whatsapp/):
//  - Send template (POST /<API_VERSION>/<PHONE_NUMBER_ID>/messages, Bearer token, body components with positional text parameters, response messages[0].id):
//    https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview and .../messages/send-messages
//  - Delivery statuses (entry[].changes[].value.statuses[]: id, status sent|delivered|read|failed, timestamp, errors[]):
//    https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status
//  - Webhook GET handshake and X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret):
//    https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
//  - Error codes and whether a retry helps: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NotifyPort } from "./gateway";
import { TEMPLATES } from "../notify/templates";

export type WhatsappConfig = { phoneNumberId: string; accessToken: string; apiVersion?: string; fetch?: typeof fetch };

// The docs' examples use v26.0. UNVERIFIED: that this is the version that stays available to this app; set WHATSAPP_API_VERSION to pin another.
const DEFAULT_VERSION = "v26.0";

// Errors where sending the same message again cannot work: bad parameters, a recipient who cannot get it (100, 131008, 131009, 131021,
// 131026, 131047, 132000, 132012). Everything else (token expired, template not approved yet, throttling, 5xx) is retried by the outbox,
// so fixing the setting lets the queue recover by itself. 131030 (recipient not in the allowed list of a test number) is UNVERIFIED: it is not in the error page.
const PERMANENT = new Set([100, 131008, 131009, 131021, 131026, 131030, 131047, 132000, 132012]);

const failure = (message: string, isPermanent: boolean) => Object.assign(new Error(message), isPermanent ? { permanent: true } : {});

/** Any common phone format -> international digits without "+" (WhatsApp wants e.g. 919876543210). Throws on anything that is not an international number. */
export function toWhatsappId(raw: string): string {
  const d = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!/^[1-9]\d{7,14}$/.test(d)) throw failure("not a valid international phone number", true);
  return d;
}

// UNVERIFIED: the "no newline, tab or run of four spaces" rule for parameter text comes from older Meta docs (error 132012); applying it costs nothing.
const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim() || "-";

/** The queue keeps the parameters as a JSON array in the row body; fall back to the live data on a first send. */
function parameters(p: { body: string; data: Record<string, string> }, names: string[]): string[] {
  try {
    const v: unknown = JSON.parse(p.body);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  } catch { /* not JSON: use data */ }
  return names.map((n) => p.data[n] ?? "");
}

export function whatsappNotify(fallback: NotifyPort, cfg: WhatsappConfig): NotifyPort {
  const f = cfg.fetch ?? fetch;
  return {
    async send(p) {
      if (p.channel !== "whatsapp") return fallback.send(p);
      const tpl = TEMPLATES[p.template]?.whatsapp;
      if (!tpl) throw failure(`no WhatsApp template for ${p.template}`, true);
      const to = toWhatsappId(p.to);
      const params = parameters(p, tpl.params).map(clean);
      const res = await f(`https://graph.facebook.com/${cfg.apiVersion ?? DEFAULT_VERSION}/${cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
          template: {
            name: tpl.template, language: { code: tpl.language },
            ...(params.length ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] } : {}),
          },
        }),
      });
      const text = await res.text();
      const j = (() => { try { return JSON.parse(text) as { error?: { code?: number; message?: string; error_data?: { details?: string } }; messages?: { id?: string }[] }; } catch { return {}; } })();
      if (!res.ok || j.error) {
        const e = j.error;
        throw failure(`whatsapp rejected the message (${e?.code ?? res.status}): ${(e?.error_data?.details ?? e?.message ?? text).slice(0, 200)}`, !!e?.code && PERMANENT.has(e.code));
      }
      const id = j.messages?.[0]?.id;
      if (!id) throw new Error(`whatsapp gave no message id: ${text.slice(0, 200)}`); // accepted but unconfirmed: the outbox retries
      return { providerRef: id };
    },
  };
}

type Receipt = { providerRef: string; status: "delivered" | "read" | "failed"; at?: Date };

/**
 * A WhatsApp webhook body -> receipts for recordDeliveryReceipt. `sent` is already what the outbox row says and `played` is for voice
 * messages, so neither is returned. A body can carry many statuses, and unrelated events (incoming messages) give an empty list.
 */
export function parseWhatsappWebhook(body: unknown): Receipt[] {
  const out: Receipt[] = [];
  const entries = (body as { entry?: unknown })?.entry;
  for (const e of Array.isArray(entries) ? entries : []) {
    for (const c of Array.isArray(e?.changes) ? e.changes : []) {
      for (const s of Array.isArray(c?.value?.statuses) ? c.value.statuses : []) {
        const status = s?.status;
        if (typeof s?.id !== "string" || !s.id || (status !== "delivered" && status !== "read" && status !== "failed")) continue;
        const secs = Number(s.timestamp);
        out.push({ providerRef: s.id, status, at: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : undefined });
      }
    }
  }
  return out;
}

/** X-Hub-Signature-256 is `sha256=` + hex HMAC of the exact raw body with the app secret. */
export function verifyWhatsappSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const want = createHmac("sha256", appSecret).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
