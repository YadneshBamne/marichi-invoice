import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { getMe } from "@/server/me";
import { privacyRequests } from "@/server/db/schema";

// The copy of a person's own data, as JSON. Only the person who asked can download it, and it is deleted a few days after it was made.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await getMe();
  const id = z.uuid().safeParse((await params).id);
  if (!u || !u.twoFactorEnabled || u.suspendedAt || !id.success) return new Response("not found", { status: 404 });
  const [r] = await db.select({ data: privacyRequests.exportData }).from(privacyRequests).where(and(eq(privacyRequests.id, id.data), eq(privacyRequests.userId, u.id), eq(privacyRequests.kind, "access")));
  if (!r?.data) return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(r.data, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="my-data.json"', "cache-control": "private, no-store" } });
}
