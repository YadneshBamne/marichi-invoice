import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { generalLedger, trialBalance } from "@/server/ledger/reports";
import { tableResponse, type Table } from "@/server/exports/table";

const Q = z.object({
  type: z.enum(["trial-balance", "general-ledger"]),
  from: z.iso.date().default("2000-01-01"),
  to: z.iso.date().default("2100-01-01"),
  format: z.enum(["csv", "xlsx", "pdf"]).default("csv"),
});

// Finance/audit export. Staff only; every export is just a read of the immutable ledger. Amounts are in minor units (paise, ngwee).
export async function GET(req: Request) {
  const s = await auth.api.getSession({ headers: await headers() });
  const role = (s?.user as { role?: string } | undefined)?.role;
  if (!s || !s.user.twoFactorEnabled || !["ops", "admin"].includes(role ?? "")) return new Response("not found", { status: 404 });
  const q = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return new Response("bad request", { status: 400 });

  const t: Table = q.data.type === "trial-balance"
    ? { title: "Trial balance", head: ["Account", "Debit minor", "Credit minor", "Balance minor"], rows: (await trialBalance(db)).rows.map((r) => [r.code, r.debit, r.credit, r.balance]) }
    : { title: `General ledger ${q.data.from} to ${q.data.to}`, head: ["At", "Ref", "Type", "Account", "Debit minor", "Credit minor"], rows: (await generalLedger(db, q.data.from, q.data.to)).map((l) => [l.at, l.ref, l.type, l.account, l.debit, l.credit]) };
  return tableResponse(t, q.data.format, q.data.type);
}
