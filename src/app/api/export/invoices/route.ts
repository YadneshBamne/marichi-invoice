import { desc, eq } from "drizzle-orm";
import { getMe } from "@/server/me";
import { effectivePicks, enabledApps } from "@/lib/apps";
import { db } from "@/server/db/client";
import { businesses, invoices } from "@/server/db/schema";
import { toCsv } from "@/server/ledger/reports";
import { toDecimal } from "@/lib/money";
import { alias } from "drizzle-orm/pg-core";

// Invoice export scoped to the caller: sellers get theirs, buyers get invoices raised against them, staff get all.
export async function GET() {
  const u = await getMe();
  if (!u || !u.twoFactorEnabled || u.suspendedAt) return new Response("not found", { status: 404 });
  // Company users need the "Reports and exports" app switched on.
  if (u.biz && !enabledApps(u.role, effectivePicks(u.biz, u.role)).has("exports")) return new Response("not found", { status: 404 });

  const seller = alias(businesses, "seller"), buyer = alias(businesses, "buyer");
  const q = db.select({ i: invoices, seller: seller.legalName, buyer: buyer.legalName }).from(invoices)
    .innerJoin(seller, eq(seller.id, invoices.sellerId)).innerJoin(buyer, eq(buyer.id, invoices.buyerId));
  const rows = u.role === "seller" && u.businessId ? await q.where(eq(invoices.sellerId, u.businessId)).orderBy(desc(invoices.createdAt)).limit(5000)
    : u.role === "buyer" && u.businessId ? await q.where(eq(invoices.buyerId, u.businessId)).orderBy(desc(invoices.createdAt)).limit(5000)
    : ["ops", "admin"].includes(u.role) ? await q.orderBy(desc(invoices.createdAt)).limit(5000)
    : null;
  if (!rows) return new Response("not found", { status: 404 });

  const body = toCsv([
    ["invoice_number", "seller", "buyer", "invoice_date", "due_date", "amount_inr", "status", "irn_status"],
    ...rows.map(({ i, seller: se, buyer: bu }) => [i.invoiceNumber, se, bu, i.invoiceDate, i.dueDate, toDecimal(i.amount), i.status, i.irnStatus]),
  ]);
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="invoices.csv"', "cache-control": "private, no-store" } });
}
