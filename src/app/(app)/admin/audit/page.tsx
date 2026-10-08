import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { searchAudit } from "@/server/admin/service";
import { DataTable, PageHead, Panel } from "@/components/ui/page";

export const metadata = { title: "Audit log" };

const compact = (v: unknown) => (v == null ? "" : JSON.stringify(v));

export default async function Audit({ searchParams }: { searchParams: Promise<{ entity?: string; action?: string }> }) {
  await requireUser(["admin", "compliance"]);
  const f = await searchParams;
  const rows = await searchAudit(db, f);
  return (
    <>
      <PageHead title="Audit log" sub="Append-only record of sensitive changes: who did what, when, and what it was before. Newest 100 entries." />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="entity" defaultValue={f.entity} placeholder="Entity, e.g. invoice" className="field-inline min-w-48 !rounded-full !py-2 text-sm" />
        <input name="action" defaultValue={f.action} placeholder="Action contains" className="field-inline min-w-48 !rounded-full !py-2 text-sm" />
        <button className="btn btn-ghost btn-sm !h-10">Filter</button>
        {(f.entity || f.action) && <a href="/admin/audit" className="btn btn-sm !h-10 text-muted">Clear</a>}
      </form>
      <Panel flush>
        <DataTable rows={rows} rowKey={(r) => r.id} empty="No matching entries."
          cols={[
            { h: "When", cell: (r) => <span className="whitespace-nowrap font-normal">{r.createdAt.toISOString().replace("T", " ").slice(0, 16)}</span> },
            { h: "Action", cell: (r) => <span className="font-mono text-[13px]">{r.action}</span> },
            { h: "Entity", cell: (r) => <>{r.entity} <span className="font-mono text-xs text-faint">{r.entityId.slice(0, 8)}</span></> },
            { h: "Actor", cell: (r) => <span className="font-mono text-xs font-normal text-muted">{r.actorId?.slice(0, 8) ?? "system"}</span> },
            { h: "Change", cell: (r) => <code className="block max-w-md truncate font-normal" title={compact({ before: r.before, after: r.after })}>{compact(r.after) || compact(r.before) || "–"}</code> },
          ]} />
      </Panel>
    </>
  );
}
