import { db } from "@/server/db/client";
import { getMe } from "@/server/me";
import { REPORTS, type ReportKind } from "@/server/analytics/service";
import { tableResponse } from "@/server/exports/table";

// A report built right now, for the signed-in person's own scope: a company sees its own data, platform staff see the whole book.
// ?format=csv (default), xlsx or pdf.
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const u = await getMe();
  if (!u || !u.twoFactorEnabled || u.suspendedAt || !(kind in REPORTS)) return new Response("not found", { status: 404 });
  const staff = ["ops", "admin"].includes(u.role);
  if (!staff && !u.businessId) return new Response("not found", { status: 404 });
  const t = await REPORTS[kind as ReportKind].table(db, { role: u.role, businessId: staff ? null : u.businessId }, new Date());
  return tableResponse(t, new URL(req.url).searchParams.get("format"), kind);
}
