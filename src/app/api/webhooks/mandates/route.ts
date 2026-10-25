import { z } from "zod";
import { db } from "@/server/db/client";
import { verifyWebhook } from "@/server/agreements/service";
import { applyDebitResult, applyMandateStatus, reconcilePendingMandates } from "@/server/collections/nach";
import { mandateStatus, parseRazorpayMandateWebhook, razorpayConfigFromEnv } from "@/server/integrations/razorpay-mandates";

const Body = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mandate"), mandateRef: z.string().min(1), status: z.enum(["active", "rejected"]), reason: z.string().optional() }),
  z.object({ type: z.literal("debit"), idempotencyKey: z.string().min(1), status: z.enum(["succeeded", "failed"]), providerRef: z.string().optional(), utr: z.string().optional(), reason: z.string().optional() }),
]);

// The bank's answers about auto-pay: a mandate was authorised or refused, or a presented debit settled or failed.
// HMAC-authenticated like the other provider webhooks; every handler is idempotent, so a replay changes nothing.
// Razorpay sends its own signature header and event shapes; anything else uses the generic shape below.
export async function POST(req: Request) {
  const raw = await req.text();
  if (req.headers.get("x-razorpay-signature")) {
    const cfg = razorpayConfigFromEnv();
    let ev;
    try { ev = parseRazorpayMandateWebhook(raw, req.headers.get("x-razorpay-signature"), process.env.RAZORPAY_WEBHOOK_SECRET ?? ""); } catch { return new Response("invalid signature", { status: 401 }); }
    if (!ev || !cfg) return new Response("ignored");
    try {
      if (ev.type === "debit") return Response.json({ status: (await applyDebitResult(db, ev)).status });
      // A token event does not say which mandate it is about, so ask Razorpay about all that are still waiting.
      return Response.json(await reconcilePendingMandates(db, (ref) => mandateStatus(cfg, ref)));
    } catch (e) {
      return new Response((e as Error).message, { status: 422 });
    }
  }
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
