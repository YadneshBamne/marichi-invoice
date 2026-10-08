import { z } from "zod";
import { db } from "@/server/db/client";
import { verifyWebhook } from "@/server/agreements/service";
import { recordIncomingPayment } from "@/server/collections/service";

const Body = z.object({
  accountNumber: z.string().min(1),
  amountPaise: z.string().regex(/^\d+$/), // integer paise as a string: JSON numbers can't safely carry large money values
  utr: z.string().min(1),
  receivedAt: z.iso.datetime(),
});

// Bank credit notification for a collection (virtual) account. HMAC-authenticated; idempotent on the UTR.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("x-signature"), process.env.PAYMENTS_WEBHOOK_SECRET ?? "")) {
    return new Response("invalid signature", { status: 401 });
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return new Response("bad request", { status: 400 }); }
  const p = Body.safeParse(json);
  if (!p.success) return new Response("bad request", { status: 400 });
  try {
    const r = await recordIncomingPayment(db, { accountNumber: p.data.accountNumber, amount: BigInt(p.data.amountPaise), utr: p.data.utr, receivedAt: new Date(p.data.receivedAt) });
    return Response.json({ status: r.status }); // unmatched is still a successful receipt: we hold it for ops
  } catch (e) {
    return new Response((e as Error).message, { status: 422 });
  }
}
