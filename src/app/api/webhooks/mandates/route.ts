import { z } from "zod";
import { db } from "@/server/db/client";
import { verifyWebhook } from "@/server/agreements/service";
import { applyDebitResult, applyMandateStatus } from "@/server/collections/nach";

const Body = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mandate"), mandateRef: z.string().min(1), status: z.enum(["active", "rejected"]), reason: z.string().optional() }),
  z.object({ type: z.literal("debit"), idempotencyKey: z.string().min(1), status: z.enum(["succeeded", "failed"]), providerRef: z.string().optional(), utr: z.string().optional(), reason: z.string().optional() }),
]);

// The bank's answers about auto-pay: a mandate was authorised or refused, or a presented debit settled or failed.
// HMAC-authenticated like the other provider webhooks; every handler is idempotent, so a replay changes nothing.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("x-signature"), process.env.MANDATE_WEBHOOK_SECRET ?? "")) return new Response("invalid signature", { status: 401 });
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  const p = Body.safeParse(json);
  if (!p.success) return new Response("bad request", { status: 400 });
  try {
    if (p.data.type === "mandate") {
      const m = await applyMandateStatus(db, p.data.mandateRef, p.data.status, p.data.reason);
      return Response.json({ status: m.status });
    }
    const r = await applyDebitResult(db, p.data);
    return Response.json({ status: r.status });
  } catch (e) {
    return new Response((e as Error).message, { status: 422 });
  }
}
