import { db } from "@/server/db/client";
import { getMe } from "@/server/me";
import { REPORTS, type ReportKind } from "@/server/analytics/service";

// A report built right now, for the signed-in person's own scope: a company sees its own data, platform staff see the whole book.
export async function GET(_: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const u = await getMe();
  if (!u || !u.twoFactorEnabled || u.suspendedAt || !(kind in REPORTS)) return new Response("not found", { status: 404 });
  const staff = ["ops", "admin"].includes(u.role);
  if (!staff && !u.businessId) return new Response("not found", { status: 404 });
  const body = await REPORTS[kind as ReportKind].build(db, { role: u.role, businessId: staff ? null : u.businessId }, new Date());
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${kind}.csv"`, "cache-control": "private, no-store" } });
}
