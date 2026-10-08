import { headers } from "next/headers";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { canViewDocument } from "@/server/agreements/service";
import { readDocument } from "@/server/vault";

export async function GET(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const s = await auth.api.getSession({ headers: await headers() });
  const user = s?.user as (NonNullable<typeof s>["user"] & { role: string; businessId: string | null }) | undefined;
  // Unauthenticated, unauthorised and missing all look the same: no document enumeration.
  if (!user || !(await canViewDocument(db, user, ref).catch(() => false))) return new Response("not found", { status: 404 });
  try {
    const { bytes, contentType } = await readDocument(ref);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
