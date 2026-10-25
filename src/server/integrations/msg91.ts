// Real SMS delivery through MSG91 (India, DLT-registered templates). Needs MSG91_AUTH_KEY and MSG91_SENDER_ID.
// Email is not handled here: it goes to the fallback port.
// Docs used (the docs.msg91.com pages render in JavaScript, so the request shape was confirmed from these):
//  - Flow API (POST /api/v5/flow, authkey header, recipients[] with variables, {type,message} reply): https://api.msg91.com/apidoc/textsms/send-sms-flow.php
//    and the current form with `template_id`: https://www.withone.ai/knowledge/msg91/conn_mod_def%3A%3AGNWEPfEWn3Q%3A%3AKr-zbEkdTQK82XTCFEhmhQ (mirror of docs.msg91.com/sms)
//  - Delivery-report webhook (requestId, status 0/1/2/9/16/17/20/25): https://msg91.com/help/webhook-new/how-to-receive-sms-delivery-reports-via-webhook-new
// The `dltTemplateId` we receive must be the MSG91 template id (the one shown in MSG91 next to the approved DLT template), not the 19-digit DLT id.
import type { NotifyPort } from "./gateway";
import { OTP_SMS, placeholders, TEMPLATES } from "../notify/templates";

const FLOW_URL = "https://control.msg91.com/api/v5/flow";

/** Indian mobile -> 91XXXXXXXXXX. Accepts +91, 91, 0 prefixes, spaces and dashes. Throws on anything else. */
export function toMsisdn(raw: string): string {
  const d = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  const m = /^(?:91|0)?([6-9]\d{9})$/.exec(d);
  if (!m) throw new Error("not a valid Indian mobile number");
  return `91${m[1]}`;
}

/**
 * The template variables. `data` is empty on retries and for OTPs (the queue only keeps the rendered text), so read the values back
 * out of the rendered body using the template wording; use `data` only if the wording is unknown or does not match.
 */
function variables(p: { template: string; data: Record<string, string>; body: string }): Record<string, string> {
  const text = p.template === "phone_otp" ? OTP_SMS.text : TEMPLATES[p.template]?.sms?.text;
  if (text) {
    const names = placeholders(text);
    const re = new RegExp(`^${text.split(/\{\{\w+\}\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*?)")}$`, "s");
    const m = re.exec(p.body);
    if (m) return Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
  }
  return Object.fromEntries(Object.entries(p.data).map(([k, v]) => [k, v.replaceAll("₹", "Rs.").replace(/[\r\n]+/g, " ")]));
}

export function msg91Notify(fallback: NotifyPort, cfg: { authKey: string; senderId: string; fetch?: typeof fetch }): NotifyPort {
  const f = cfg.fetch ?? fetch;
  return {
    async send(p) {
      if (p.channel !== "sms") return fallback.send(p);
      if (!p.dltTemplateId) throw new Error("sms needs a template id");
      const mobiles = toMsisdn(p.to);
      const res = await f(FLOW_URL, {
        method: "POST",
        headers: { authkey: cfg.authKey, accept: "application/json", "content-type": "application/json" },
        // UNVERIFIED: `sender` is only documented in the older flow_id form (needed when the flow takes its sender from the API).
        body: JSON.stringify({ template_id: p.dltTemplateId, sender: cfg.senderId, short_url: "0", recipients: [{ mobiles, ...variables(p) }] }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`sms provider rejected the message (${res.status}): ${text.slice(0, 200)}`); // thrown so the outbox retries
      const j = (() => { try { return JSON.parse(text) as { type?: string; message?: string; code?: string | number }; } catch { return {}; } })();
      // A 200 can still be a failure: the docs say to treat type "error" or code 201 as one.
      if (j.type !== "success" || !j.message || String(j.code) === "201") throw new Error(`sms provider failed: ${text.slice(0, 200)}`);
      return { providerRef: j.message };
    },
  };
}

// 1 = delivered; 2 failed, 9 DND (promotional only), 16/25 rejected, 17 blocked number, 20 country blocked. 0 = sent: not final, so no receipt.
const FAILED = new Set([2, 9, 16, 17, 20, 25]);

/** One MSG91 delivery-report callback (JSON body) -> what recordDeliveryReceipt takes. null = nothing to record (not a final status). */
export function parseMsg91Report(body: unknown): { providerRef: string; status: "delivered" | "failed" } | null {
  const b = (body ?? {}) as { requestId?: unknown; status?: unknown };
  const ref = typeof b.requestId === "string" ? b.requestId : "";
  const s = Number(b.status);
  if (!ref || b.status === "" || b.status == null) return null;
  if (s === 1) return { providerRef: ref, status: "delivered" };
  return FAILED.has(s) ? { providerRef: ref, status: "failed" } : null;
}
