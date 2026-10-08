import { z } from "zod";
import { db } from "@/server/db/client";
import { verifyWebhook } from "@/server/agreements/service";
import { settleDisbursement } from "@/server/disbursements/service";

const Body = z.object({ bankRef: z.string().min(1), status: z.enum(["succeeded", "failed"]), reason: z.string().optional() });

// Payout status callback from the BaaS/bank layer. HMAC-authenticated; idempotent. The poller covers a missed webhook.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("x-signature"), process.env.PAYMENTS_WEBHOOK_SECRET ?? "")) {
    return new Response("invalid signature", { status: 401 });
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return new Response("bad request", { status: 400 });
  try {
    await settleDisbursement(db, parsed.data.bankRef, parsed.data.status, parsed.data.reason);
  } catch (e) {
    return new Response((e as Error).message, { status: /unknown/.test((e as Error).message) ? 404 : 409 });
  }
  return new Response("ok");
}
