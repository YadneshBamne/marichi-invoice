import { timingSafeEqual } from "node:crypto";
import { db } from "@/server/db/client";
import { parseWhatsappWebhook, verifyWhatsappSignature } from "@/server/integrations/whatsapp";
import { recordDeliveryReceipt } from "@/server/notify";

// Meta checks the address when the webhook is saved in the App Dashboard: it sends hub.mode, hub.verify_token and hub.challenge,
// and wants the challenge back if the token is the one we chose (WHATSAPP_VERIFY_TOKEN).
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const want = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
  const got = q.get("hub.verify_token") ?? "";
  const ok = want.length > 0 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  const challenge = q.get("hub.challenge");
  return q.get("hub.mode") === "subscribe" && ok && challenge ? new Response(challenge) : new Response("forbidden", { status: 403 });
}

// Delivery statuses for messages we sent. Signed by Meta with the app secret (X-Hub-Signature-256).
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWhatsappSignature(raw, req.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET ?? "")) {
    return new Response("invalid signature", { status: 401 });
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  for (const r of parseWhatsappWebhook(json)) {
    try {
      await recordDeliveryReceipt(db, r);
    } catch (e) {
      // A status for a message we do not have (sent by another system on the same number) must not make Meta retry for 7 days.
      if (!/unknown provider reference/.test((e as Error).message)) return new Response("try again", { status: 500 });
    }
  }
  return new Response("ok");
}
