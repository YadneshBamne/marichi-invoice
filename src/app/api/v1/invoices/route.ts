import { after } from "next/server";
import { db } from "@/server/db/client";
import { scanInvoice } from "@/server/fraud/engine";
import { sendForConfirmation } from "@/server/confirmations/service";
import { ApiError, createSellerInvoice, InvoiceInput, listInvoices } from "@/server/erp/invoices";
import { authed, fail, fromError, reply } from "../_lib";

const STATUSES = ["uploaded", "validated", "sent_for_confirmation", "confirmed", "disputed", "eligible", "financed", "due", "paid", "overdue", "written_off", "rejected"];

// GET /api/v1/invoices?status=&limit=&before=   Sellers see their invoices; buyers see invoices raised on them.
export async function GET(req: Request) {
  const a = await authed(req);
  if ("res" in a) return a.res;
  const q = new URL(req.url).searchParams;
  const status = q.get("status") ?? undefined;
  if (status && !STATUSES.includes(status)) return fail(400, "BAD_REQUEST", `status must be one of: ${STATUSES.join(", ")}`);
  const before = q.get("before") ? new Date(q.get("before")!) : undefined;
  if (before && Number.isNaN(before.getTime())) return fail(400, "BAD_REQUEST", "before must be an ISO date-time");
  const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
  if (limit !== undefined && !Number.isInteger(limit)) return fail(400, "BAD_REQUEST", "limit must be a whole number");
  return reply(await listInvoices(db, { businessId: a.who.businessId, kind: a.who.kind, status, limit, before }));
}

// POST /api/v1/invoices   (sellers only) Raises an invoice exactly as an upload in the app would.
export async function POST(req: Request) {
  const a = await authed(req);
  if ("res" in a) return a.res;
  if (a.who.kind !== "seller") return fail(403, "FORBIDDEN", "only a seller key can create invoices");
  let json: unknown;
  try { json = await req.json(); } catch { return fail(400, "BAD_REQUEST", "the body must be JSON"); }
  const p = InvoiceInput.safeParse(json);
  if (!p.success) return fail(422, "INVALID", p.error.issues[0].message, { field: p.error.issues[0].path.join(".") });
  try {
    const r = await createSellerInvoice(db, a.who.businessId, p.data, "api");
    after(async () => {
      await scanInvoice(db, r.id).catch((e) => console.error("[fraud-scan]", e.message));
      if (r.status === "validated") await sendForConfirmation(db, r.id).catch((e) => console.error("[confirm]", e.message));
    });
    return reply({ number: p.data.invoiceNumber, status: r.status, irnStatus: r.irnStatus }, 201);
  } catch (e) {
    return e instanceof ApiError ? fromError(e) : fail(500, "SERVER_ERROR", "something went wrong on our side");
  }
}
