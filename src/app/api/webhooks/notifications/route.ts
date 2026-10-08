import { z } from "zod";
import { db } from "@/server/db/client";
import { verifyWebhook } from "@/server/agreements/service";
import { recordDeliveryReceipt } from "@/server/notify";

const Body = z.object({ providerRef: z.string().min(1), status: z.enum(["delivered", "read", "failed"]), at: z.iso.datetime().optional() });

// SMS/email provider delivery receipts. HMAC-authenticated; idempotent and monotonic (a late "delivered" never downgrades "read").
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("x-signature"), process.env.NOTIFY_WEBHOOK_SECRET ?? "")) {
    return new Response("invalid signature", { status: 401 });
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  const p = Body.safeParse(json);
  if (!p.success) return new Response("bad request", { status: 400 });
  try {
    await recordDeliveryReceipt(db, { providerRef: p.data.providerRef, status: p.data.status, at: p.data.at ? new Date(p.data.at) : undefined });
  } catch (e) {
    return new Response((e as Error).message, { status: 404 });
  }
  return new Response("ok");
}
