import { and, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { getMe } from "@/server/me";
import { reportRuns } from "@/server/db/schema";

// A saved scheduled report. Only the person it was built for can download it.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await getMe();
  if (!u || !u.twoFactorEnabled || u.suspendedAt || !/^[0-9a-f-]{36}$/.test(id)) return new Response("not found", { status: 404 });
  const [r] = await db.select().from(reportRuns).where(and(eq(reportRuns.id, id), eq(reportRuns.userId, u.id)));
  if (!r) return new Response("not found", { status: 404 });
  return new Response(r.content, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.filename}"`, "cache-control": "private, no-store" } });
}
