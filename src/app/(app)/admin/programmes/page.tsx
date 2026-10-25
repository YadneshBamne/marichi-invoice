import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { decideProgramme, listProgrammes, SCF } from "@/server/scf/service";
import { DataTable, Notice, PageHead, Panel, StatusPill, Pop } from "@/components/ui/page";
import { formatMoney, rupeesToPaise } from "@/lib/money";
import { attempt } from "../../financier/attempt";
import { market } from "@/lib/countries";
import { PopField } from "@/components/ui/page";

export const metadata = { title: "Programmes" };
const PATH = "/admin/programmes";

async function decide(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin"]);
  await attempt(PATH, async () => {
    const f = z.object({
      id: z.uuid(), decision: z.enum(["approve", "decline", "pause", "resume"]), note: z.string().optional(),
      limit: z.string().optional(), discountPct: z.coerce.number().optional(), advancePct: z.coerce.number().optional(),
    }).parse(Object.fromEntries(fd));
    await decideProgramme(db, u, f.id, {
      decision: f.decision, note: f.note, limit: f.limit ? rupeesToPaise(f.limit) : undefined,
      discountBps: f.discountPct ? Math.round(f.discountPct * 100) : undefined, advanceBps: f.advancePct ? Math.round(f.advancePct * 100) : undefined,
    });
    return `Programme ${{ approve: "approved", decline: "declined", pause: "paused", resume: "resumed" }[f.decision]}.`;
  });
}

export default async function Programmes({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["ops", "admin"]);
  const q = await searchParams;
  const rows = await listProgrammes(db);
  return (
    <>
      <PageHead title="Supplier finance programmes" sub="Approve a buyer's programme with a limit and a price based on the buyer's credit. Suppliers in an active programme are priced at that rate." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <Panel flush>
        <DataTable rows={rows} rowKey={(r) => r.p.id} empty="No programmes yet."
          cols={[
            { h: "Buyer", cell: (r) => <>{r.buyer}<span className="block text-xs font-normal text-muted">{r.p.name}</span></> },
            { h: "Status", cell: (r) => <StatusPill status={r.p.status === "active" ? "approved" : r.p.status === "requested" || r.p.status === "paused" ? "pending" : "rejected"} label={r.p.status} /> },
            { h: "Asked", align: "right", cell: (r) => formatMoney(r.p.requestedLimit) },
            { h: "Limit", align: "right", cell: (r) => (r.p.limit > 0n ? formatMoney(r.p.limit) : "-") },
            { h: "In use", align: "right", cell: (r) => formatMoney(r.used) },
            { h: "Price", align: "right", cell: (r) => (r.p.discountBps ? `${r.p.discountBps / 100}% / ${(r.p.advanceBps ?? 0) / 100}%` : "-") },
            { h: "", align: "right", cell: (r) => r.p.status === "requested" ? (
              <Pop id={`pd-${r.p.id}`} label="Decide" cls="btn btn-primary btn-sm">
                <form action={decide} className="space-y-2">
                  <input type="hidden" name="id" value={r.p.id} />
                  <PopField label={`Limit (${market().currency.code})`}><input name="limit" inputMode="decimal" defaultValue={(Number(r.p.requestedLimit) / 100).toString()} className="field !py-2 text-sm font-normal" /></PopField>
                  <PopField label="Yearly discount (%)"><input name="discountPct" type="number" step="0.01" min={SCF.minDiscountBps / 100} max={SCF.maxDiscountBps / 100} className="field !py-2 text-sm font-normal" /></PopField>
                  <PopField label="Advance (% of invoice)"><input name="advancePct" type="number" step="0.01" max={SCF.maxAdvanceBps / 100} className="field !py-2 text-sm font-normal" /></PopField>
                  <PopField label="Note (required to decline)"><input name="note" className="field !py-2 text-sm font-normal" /></PopField>
                  <div className="flex gap-2"><button name="decision" value="approve" className="btn btn-primary btn-sm flex-1">Approve</button><button name="decision" value="decline" className="btn btn-ghost btn-sm flex-1">Decline</button></div>
                </form>
              </Pop>
            ) : (r.p.status === "active" || r.p.status === "paused") ? (
              <form action={decide}><input type="hidden" name="id" value={r.p.id} /><button name="decision" value={r.p.status === "active" ? "pause" : "resume"} className="btn btn-ghost btn-sm">{r.p.status === "active" ? "Pause" : "Resume"}</button></form>
            ) : null },
          ]} />
      </Panel>
    </>
  );
}
