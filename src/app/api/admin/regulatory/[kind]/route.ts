import { headers } from "next/headers";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { buildReport, isKind } from "@/server/regulatory/reports";
import { tableResponse } from "@/server/exports/table";

// Draft returns for the regulator. Admin and compliance only (they carry tax and registration numbers), and every download is logged.
// ?format=csv (default), xlsx or pdf. The STR draft also takes ?from=YYYY-MM-DD&to=YYYY-MM-DD.
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const s = await auth.api.getSession({ headers: await headers() });
  const u = s?.user as { id: string; role?: string; twoFactorEnabled?: boolean | null; suspendedAt?: unknown } | undefined;
  if (!s || !u || !u.twoFactorEnabled || u.suspendedAt || !["admin", "compliance"].includes(u.role ?? "") || !isKind(kind)) return new Response("not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  try {
    const t = await buildReport(db, { id: u.id, role: u.role! }, kind, { from: q.get("from") ?? undefined, to: q.get("to") ?? undefined });
    return tableResponse(t, q.get("format"), `${kind}-draft-${new Date().toISOString().slice(0, 10)}`);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "bad request", { status: 400 });
  }
}
