import { z } from "zod";
import { db } from "@/server/db/client";
import { respondViaApi } from "@/server/confirmations/service";
import { authed, fail, reply } from "../../../_lib";

const Body = z.object({ decision: z.enum(["confirm", "dispute", "clarify"]), note: z.string().trim().max(1000).optional() });

// POST /api/v1/invoices/INV-001/response   (buyers only)   {"decision":"confirm"|"dispute"|"clarify","note":"..."}
// The buyer's accounts-payable system answers a supplier's invoice. A note is required to dispute or to ask a question.
export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const a = await authed(req);
  if ("res" in a) return a.res;
  if (a.who.kind !== "buyer") return fail(403, "FORBIDDEN", "only a buyer key can answer an invoice");
  let json: unknown;
  try { json = await req.json(); } catch { return fail(400, "BAD_REQUEST", "the body must be JSON"); }
  const b = Body.safeParse(json);
  if (!b.success) return fail(422, "INVALID", b.error.issues[0].message, { field: b.error.issues[0].path.join(".") });
  try {
    const r = await respondViaApi(db, { businessId: a.who.businessId, keyId: a.who.keyId, invoiceNumber: decodeURIComponent((await params).number), ...b.data, ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() });
    return reply({ number: decodeURIComponent((await params).number), status: r.status });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "NOT_FOUND") return fail(404, "NOT_FOUND", "no invoice with that number is raised on you");
    if (/not awaiting confirmation/.test(m)) return fail(409, "NOT_AWAITING", m);
    if (/note is required/.test(m)) return fail(422, "INVALID", m, { field: "note" });
    return fail(500, "SERVER_ERROR", "something went wrong on our side");
  }
}
