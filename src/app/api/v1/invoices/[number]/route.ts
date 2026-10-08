import { db } from "@/server/db/client";
import { listInvoices } from "@/server/erp/invoices";
import { authed, fail, reply } from "../../_lib";

// GET /api/v1/invoices/INV-001   One invoice by its number.
export async function GET(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const a = await authed(req);
  if ("res" in a) return a.res;
  const number = decodeURIComponent((await params).number);
  const r = await listInvoices(db, { businessId: a.who.businessId, kind: a.who.kind, number, limit: 1 });
  return r.items[0] ? reply(r.items[0]) : fail(404, "NOT_FOUND", "no invoice with that number");
}
