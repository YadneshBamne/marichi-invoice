import { z } from "zod";
import { db } from "@/server/db/client";
import { getMe } from "@/server/me";
import { PushSubscriptionBody, removePushSubscription, savePushSubscription } from "@/server/notify/push";

// The signed-in person's browser signs up for (POST) or leaves (DELETE) push notifications. Subscriptions belong to the person, never to a company.
async function body(req: Request) {
  // JSON only: a plain form post from another site cannot carry this content type.
  if (!req.headers.get("content-type")?.includes("application/json")) return null;
  const raw = await req.text();
  if (raw.length > 4096) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

export async function POST(req: Request) {
  const u = await getMe();
  if (!u || u.suspendedAt) return new Response("sign in first", { status: 401 });
  const p = PushSubscriptionBody.safeParse(await body(req));
  if (!p.success) return new Response("bad subscription", { status: 400 });
  try {
    await savePushSubscription(db, u.id, p.data, req.headers.get("user-agent"));
  } catch (e) {
    return new Response((e as Error).message, { status: 409 });
  }
  return new Response("ok");
}

export async function DELETE(req: Request) {
  const u = await getMe();
  if (!u || u.suspendedAt) return new Response("sign in first", { status: 401 });
  const p = z.object({ endpoint: z.string().max(2048) }).safeParse(await body(req));
  if (!p.success) return new Response("bad request", { status: 400 });
  await removePushSubscription(db, u.id, p.data.endpoint);
  return new Response("ok");
}
