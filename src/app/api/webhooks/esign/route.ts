import { z } from "zod";
import { db } from "@/server/db/client";
import { completeSignature, verifyWebhook } from "@/server/agreements/service";
import { parseDigioWebhook } from "@/server/integrations/digio";

const Body = z.object({ requestId: z.string().min(1), status: z.enum(["signed", "failed"]), signerEmail: z.email().optional() });

// E-sign provider callback. Authenticated by HMAC over the raw body; replays are harmless (idempotent).
// Digio sends its own checksum header and body shape; anything else uses the generic shape below (also what the sandbox sends).
export async function POST(req: Request) {
  const raw = await req.text();
  if (req.headers.get("x-digio-checksum")) {
    let ev;
    try { ev = parseDigioWebhook(raw, req.headers, process.env.ESIGN_WEBHOOK_SECRET ?? ""); } catch { return new Response("invalid signature", { status: 401 }); }
    if (!ev) return new Response("ignored"); // an event we do not act on: still a 200, so Digio does not keep retrying
    try {
      await completeSignature(db, { requestId: ev.requestId, outcome: ev.outcome, signer: ev.signer });
    } catch (e) {
      return new Response((e as Error).message, { status: /unknown/.test((e as Error).message) ? 404 : 409 });
    }
    return new Response("ok");
  }
  if (!verifyWebhook(raw, req.headers.get("x-signature"), process.env.ESIGN_WEBHOOK_SECRET ?? "")) {
    return new Response("invalid signature", { status: 401 });
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return new Response("bad request", { status: 400 });
  try {
    await completeSignature(db, { requestId: parsed.data.requestId, outcome: parsed.data.status, signer: { email: parsed.data.signerEmail } });
  } catch (e) {
    return new Response((e as Error).message, { status: /unknown/.test((e as Error).message) ? 404 : 409 });
  }
  return new Response("ok");
}
