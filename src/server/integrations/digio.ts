// Real e-signature through Digio (India). Needs DIGIO_CLIENT_ID and DIGIO_CLIENT_SECRET; sandbox unless env is "production".
// Docs used:
//   Create sign request (JSON, base64 PDF): https://documentation.digio.in/digisign/api_integration/create_sign_request/
//     (field list read from the page's OpenAPI file https://documentation.digio.in/swagger/post_uploadPdfFile.json)
//   Environments (base URLs): https://documentation.digio.in/digienvironments/
//   Sign webhook events and payloads: https://documentation.digio.in/digisign/api_integration/webhooks/
//   Webhook structure and checksum header: https://documentation.digio.in/webhooks/structure/ and https://documentation.digio.in/webhooks/faq/
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EsignPort } from "./gateway";

const BASE = { sandbox: "https://ext.digio.in:444", production: "https://api.digio.in" };

export type DigioConfig = {
  clientId: string; clientSecret: string; env: "sandbox" | "production";
  readDocument?: (ref: string) => Promise<{ bytes: Buffer }>; fetch?: typeof fetch;
};

export function digioEsign(cfg: DigioConfig): EsignPort {
  const f = cfg.fetch ?? fetch;
  const read = cfg.readDocument ?? ((ref: string) => import("../vault").then((v) => v.readDocument(ref)));
  const auth = "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  return {
    async request(p) {
      const { bytes } = await read(p.documentRef);
      const res = await f(`${BASE[cfg.env]}/v2/client/document/uploadpdf`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          file_name: p.documentRef,
          file_data: Buffer.from(bytes).toString("base64"),
          // Digio dedupes on this id: a repeat returns the earlier document instead of creating a second request.
          // UNVERIFIED: the field is named `callback` but its description says "unique ID ... for idempotency"; confirm in sandbox.
          callback: p.idempotencyKey,
          signers: [{ identifier: p.signer, reason: "Agreement with Marichi", sign_type: "aadhaar" }], // identifier is an email or mobile; aadhaar is Digio's documented default
          notify_signers: true, // Digio emails the signing link
        }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        throw new Error(`e-sign provider rejected the request (${res.status}): ${e.code ?? ""} ${e.message ?? ""}`.trim()); // thrown so the worker retries
      }
      const j = (await res.json().catch(() => ({}))) as { id?: string };
      if (!j.id) throw new Error("e-sign provider returned no document id");
      return { requestId: j.id };
    },
  };
}

type Headers_ = Headers | Record<string, string | null | undefined>;
type Party = { identifier?: string; status?: string };

/**
 * Check a Digio webhook and turn it into what completeSignature takes. Throws when the checksum is wrong.
 * Returns null for events we don't act on (Digio wants a 200 for those anyway).
 */
export type DigioEvent = { requestId: string; outcome: "signed" | "failed"; signer?: { email?: string; ip?: string; userAgent?: string } };
export function parseDigioWebhook(rawBody: string, headers: Headers_, secret: string): DigioEvent | null {
  const sum = headers instanceof Headers ? headers.get("x-digio-checksum")
    : Object.entries(headers).find(([k]) => k.toLowerCase() === "x-digio-checksum")?.[1] ?? null;
  // HMAC-SHA256 hex of the body with the account's webhook secret, sent in X-Digio-Checksum.
  // UNVERIFIED: the docs say "payload" without saying whether that is the raw body bytes; we use the raw body.
  const want = createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(sum ?? "", "hex");
  if (!secret || !sum || got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("invalid webhook checksum");

  const j = JSON.parse(rawBody) as { event?: string; payload?: { document?: { id?: string; signing_parties?: Party[] } } };
  const outcome = j.event === "doc.signed" ? "signed" : j.event === "doc.sign.failed" || j.event === "doc.sign.rejected" ? "failed" : null;
  const doc = j.payload?.document;
  if (!outcome || !doc?.id) return null;
  const who = doc.signing_parties?.find((s) => s.status === "signed" && s.identifier?.includes("@"));
  // The payload carries no IP address or browser string for the signer.
  return { requestId: doc.id, outcome, signer: who ? { email: who.identifier } : undefined };
}
