import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses, users } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { position, recordFunding, recordWithdrawal } from "@/server/marketplace/service";
import { DataTable, Notice, PageHead, Panel, Pop } from "@/components/ui/page";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { attempt } from "../../financier/attempt";

export const metadata = { title: "Financiers" };
const PATH = "/admin/financiers";
const Form = z.object({ financierId: z.uuid(), amount: z.string(), ref: z.uuid(), kind: z.enum(["fund", "withdraw"]), bankRef: z.string().max(60).optional() });

async function move(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin"]);
  await attempt(PATH, async () => {
    const f = Form.parse(Object.fromEntries(fd));
    const amount = rupeesToPaise(f.amount);
    const p = { financierId: f.financierId, amount, ref: f.bankRef?.trim() ? `${f.bankRef.trim()}` : f.ref, staffId: u.id, staffRole: u.role };
    await (f.kind === "fund" ? recordFunding : recordWithdrawal)(db, p);
    return f.kind === "fund" ? `Recorded ${formatINR(amount)} in.` : `Recorded ${formatINR(amount)} out.`;
  });
}

export default async function Financiers({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["ops", "admin"]);
  const q = await searchParams;
  const list = await db.selectDistinct({ id: businesses.id, name: businesses.legalName, kyb: businesses.kybStatus }).from(businesses)
    .innerJoin(users, and(eq(users.businessId, businesses.id), eq(users.role, "financier")));
  const rows = await Promise.all(list.map(async (b) => ({ ...b, pos: await position(db, b.id) })));
  return (
    <>
      <PageHead title="Financiers" sub="Record deposits and withdrawals for financier companies. Money only counts once it has landed in escrow." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <Panel flush>
        <DataTable rows={rows} rowKey={(r) => r.id} empty="No financier companies yet."
          cols={[
            { h: "Company", cell: (r) => <>{r.name}<span className="block text-xs font-normal text-muted">verification: {r.kyb.replaceAll("_", " ")}</span></> },
            { h: "In escrow", align: "right", cell: (r) => formatINR(r.pos.funds) },
            { h: "Promised", align: "right", cell: (r) => formatINR(r.pos.reserved) },
            { h: "Deployed", align: "right", cell: (r) => formatINR(r.pos.deployed) },
            { h: "", align: "right", cell: (r) => (
              <Pop id={`pf-${r.id}`} label="Record movement" cls="btn btn-ghost btn-sm">
                <form action={move} className="space-y-2">
                  <input type="hidden" name="financierId" value={r.id} />
                  <input type="hidden" name="ref" value={crypto.randomUUID()} />
                  <select name="kind" className="field !py-2 text-sm"><option value="fund">Deposit received</option><option value="withdraw">Withdrawal paid</option></select>
                  <input name="amount" inputMode="decimal" placeholder="Amount (₹)" required className="field !py-2 text-sm" />
                  <input name="bankRef" placeholder="Bank reference (UTR)" className="field !py-2 text-sm" />
                  <button className="btn btn-primary btn-sm w-full">Record</button>
                </form>
              </Pop>
            ) },
          ]} />
      </Panel>
    </>
  );
}
