import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { generalLedger, toCsv, trialBalance } from "@/server/ledger/reports";

const Q = z.object({
  type: z.enum(["trial-balance", "general-ledger"]),
  from: z.iso.date().default("2000-01-01"),
  to: z.iso.date().default("2100-01-01"),
});

// Finance/audit export. Staff only; every export is just a read of the immutable ledger.
export async function GET(req: Request) {
  const s = await auth.api.getSession({ headers: await headers() });
  const role = (s?.user as { role?: string } | undefined)?.role;
  if (!s || !s.user.twoFactorEnabled || !["ops", "admin"].includes(role ?? "")) return new Response("not found", { status: 404 });
  const q = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return new Response("bad request", { status: 400 });

  const body = q.data.type === "trial-balance"
    ? toCsv([["account", "debit_paise", "credit_paise", "balance_paise"], ...(await trialBalance(db)).rows.map((r) => [r.code, r.debit, r.credit, r.balance])])
    : toCsv([["at", "ref", "type", "account", "debit_paise", "credit_paise"], ...(await generalLedger(db, q.data.from, q.data.to)).map((l) => [l.at, l.ref, l.type, l.account, l.debit, l.credit])]);
  return new Response(body, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${q.data.type}.csv"`, "cache-control": "private, no-store" },
  });
}
