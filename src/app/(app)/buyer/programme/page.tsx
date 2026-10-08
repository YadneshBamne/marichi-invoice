import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { assertCan, can } from "@/server/permissions";
import { applyForProgramme, inviteSuppliers, programmeReport, removeSupplier } from "@/server/scf/service";
import { DataTable, EmptyState, Field, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { attempt } from "../../financier/attempt";

export const metadata = { title: "Supplier finance" };
const PATH = "/buyer/programme";
const input = "field font-normal";
const WORDS: Record<string, string> = { invited: "invited", already: "already invited", not_found: "not on Marichi", not_verified: "not verified yet", invalid: "not a valid GSTIN", self: "your own GSTIN" };

async function apply(fd: FormData) {
  "use server";
  const u = await requireUser(["buyer"]);
  await attempt(PATH, async () => {
    assertCan(u, "programme.manage");
    const f = z.object({ name: z.string().min(2).max(80), limit: z.string() }).parse(Object.fromEntries(fd));
    await applyForProgramme(db, { id: u.id, role: u.role, businessId: u.businessId }, { name: f.name, limit: rupeesToPaise(f.limit) });
    return "Sent to our credit team. You will be told when it is approved, with your limit and price.";
  });
}
async function invite(fd: FormData) {
  "use server";
  const u = await requireUser(["buyer"]);
  await attempt(PATH, async () => {
    assertCan(u, "programme.manage");
    const raw = String(fd.get("gstins") ?? "").split(/[\s,;]+/);
    const r = await inviteSuppliers(db, { id: u.id, role: u.role, businessId: u.businessId }, raw);
    const by = new Map<string, string[]>();
    for (const x of r) by.set(x.result, [...(by.get(x.result) ?? []), x.gstin]);
    return [...by.entries()].map(([k, v]) => `${v.length} ${WORDS[k]}${k === "invited" || k === "already" ? "" : ` (${v.slice(0, 3).join(", ")}${v.length > 3 ? "…" : ""})`}`).join("; ") + ".";
  });
}
async function remove(fd: FormData) {
  "use server";
  const u = await requireUser(["buyer"]);
  await attempt(PATH, async () => {
    assertCan(u, "programme.manage");
    await removeSupplier(db, { id: u.id, role: u.role, businessId: u.businessId }, z.uuid().parse(fd.get("programmeId")), z.uuid().parse(fd.get("sellerId")));
    return "Supplier removed from the programme.";
  });
}

export default async function Programme({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["buyer"]);
  const q = await searchParams;
  const may = can(u, "programme.manage");
  const r = await programmeReport(db, u.businessId!);
  const banner = (<>
    {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
    {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
    {!may && <div className="mb-4"><Notice tone="warn">Running a programme commits the company. Ask a manager or the owner.</Notice></div>}
  </>);

  if (!r) return (
    <>
      <PageHead title="Supplier finance" sub="Let your suppliers get paid early against invoices you have approved, priced on your credit rather than theirs." />
      {banner}
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Panel title="How it works">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
            <li>Apply with the limit you want. Our credit team sets the limit and a yearly price from your credit.</li>
            <li>Invite your suppliers by GSTIN, in bulk. Each one chooses whether to join.</li>
            <li>Their invoices that you confirm are offered financing at your price, up to the limit.</li>
            <li>You pay on the due date as usual. The programme page shows what is due when.</li>
          </ol>
        </Panel>
        {may && (
          <Panel title="Apply for a programme">
            <form action={apply} className="space-y-4">
              <Field label="Programme name"><input name="name" required defaultValue="Supplier programme" className={input} /></Field>
              <Field label="Limit you want (₹)"><input name="limit" inputMode="decimal" required placeholder="e.g. 5,00,00,000" className={input} /></Field>
              <button className="btn btn-primary w-full">Apply</button>
            </form>
          </Panel>
        )}
      </div>
    </>
  );

  const { prog } = r;
  if (prog.status === "requested") return (
    <>
      <PageHead title="Supplier finance" sub={prog.name} />
      {banner}
      <EmptyState icon="clock" title="Waiting for our credit team">You asked for a limit of {formatINR(prog.requestedLimit)}. We will set your limit and price and let you know.</EmptyState>
    </>
  );

  const active = r.suppliers.filter((s) => s.s.status === "active").length;
  return (
    <>
      <PageHead title="Supplier finance" sub={`${prog.name} · priced at ${(prog.discountBps ?? 0) / 100}% a year, advancing ${(prog.advanceBps ?? 0) / 100}% of each invoice`}>
        {prog.status === "paused" && <StatusPill status="pending" label="Paused" />}
      </PageHead>
      {banner}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Limit" value={formatINR(prog.limit)} note={`${formatINR(prog.limit - r.used)} still available`} />
        <Stat label="In use" value={formatINR(r.used)} note={`${prog.limit > 0n ? Number((r.used * 100n) / prog.limit) : 0}% of the limit`} />
        <Stat label="Suppliers" value={String(active)} note={`${r.suppliers.length - active} invited or inactive`} />
        <Stat label="Financed" value={formatINR(r.financed)} note={r.summary} />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_22rem]">
        <Panel title="Suppliers" flush>
          <DataTable rows={r.suppliers} rowKey={(s) => s.s.id} empty="No suppliers yet. Invite some."
            cols={[
              { h: "Supplier", cell: (s) => s.name },
              { h: "GSTIN", cell: (s) => <span className="font-mono text-[13px] font-normal text-muted">{s.gstin}</span> },
              { h: "Status", cell: (s) => <StatusPill status={s.s.status === "active" ? "approved" : s.s.status === "invited" ? "pending" : "rejected"} label={s.s.status} /> },
              { h: "", align: "right", cell: (s) => may && ["active", "invited"].includes(s.s.status) && (
                <form action={remove}><input type="hidden" name="programmeId" value={prog.id} /><input type="hidden" name="sellerId" value={s.s.sellerId} /><button className="btn btn-ghost btn-sm">Remove</button></form>
              ) },
            ]} />
        </Panel>
        {may && prog.status === "active" && (
          <Panel title="Invite suppliers" sub="Paste GSTINs, one per line or separated by commas.">
            <form action={invite} className="space-y-3">
              <textarea name="gstins" required rows={6} placeholder={"27AAAAA1111A1Z5\n29BBBBB2222B1Z5"} className="field font-mono text-xs font-normal" />
              <button className="btn btn-primary w-full">Send invitations</button>
              <p className="text-xs text-muted">Only suppliers already verified on Marichi can be invited. Invitations are not sent to anyone else.</p>
            </form>
          </Panel>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_20rem]">
        <Panel title="Approved invoices" sub="Confirmed invoices from your programme suppliers" flush>
          <DataTable rows={r.feed} rowKey={(f) => f.i.id} empty="No approved invoices from programme suppliers yet."
            cols={[
              { h: "Invoice", cell: (f) => f.i.invoiceNumber },
              { h: "Supplier", cell: (f) => f.seller },
              { h: "Amount", align: "right", cell: (f) => formatINR(f.i.amount) },
              { h: "Due", cell: (f) => f.i.dueDate },
              { h: "Financed", align: "right", cell: (f) => (f.o ? formatINR(f.o.advanceAmount) : <span className="text-faint">not yet</span>) },
              { h: "Status", cell: (f) => <StatusPill status={f.i.status} /> },
            ]} />
        </Panel>
        <Panel title="Payment calendar" sub="What you will owe, by due date" flush>
          <DataTable rows={r.calendar} rowKey={(c) => c.date} empty="Nothing due."
            cols={[
              { h: "Due", cell: (c) => c.date },
              { h: "Invoices", align: "right", cell: (c) => c.count },
              { h: "Amount", align: "right", cell: (c) => formatINR(c.due) },
            ]} />
        </Panel>
      </div>
    </>
  );
}
