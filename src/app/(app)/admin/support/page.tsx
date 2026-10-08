import Link from "next/link";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { staffQueue } from "@/server/support/service";
import { KINDS, type Kind } from "@/server/support/policy";
import { DataTable, PageHead, Panel, StatusPill, Tabs } from "@/components/ui/page";

export const metadata = { title: "Support queue" };
const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export default async function SupportQueue({ searchParams }: { searchParams: Promise<{ level?: string; kind?: string; view?: string }> }) {
  await requireUser(["ops", "admin", "compliance"]);
  const q = await searchParams;
  const level = [1, 2, 3].includes(Number(q.level)) ? Number(q.level) : undefined;
  const kind = (KINDS as string[]).includes(q.kind ?? "") ? (q.kind as Kind) : undefined;
  const view = q.view === "breached" ? "breached" : q.view === "closed" ? "closed" : "open";
  const rows = await staffQueue(db, { level, kind, open: view === "open" ? true : view === "closed" ? false : undefined, breached: view === "breached" });
  const link = (p: Record<string, string | undefined>) => "?" + new URLSearchParams(Object.entries({ level: q.level, kind: q.kind, view, ...p }).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <>
      <PageHead title="Support queue" sub="Customer tickets with response and resolution timers. Tickets escalate automatically when a timer is missed." />
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Tabs items={["open", "breached", "closed"].map((v) => ({ href: link({ view: v }), label: v === "breached" ? "SLA missed" : v[0].toUpperCase() + v.slice(1), active: v === view }))} />
        <label className="flex items-center gap-2 text-[13px] font-medium text-muted">Level
          <Tabs items={[undefined, "1", "2", "3"].map((l) => ({ href: link({ level: l }), label: l ?? "All", active: String(level ?? "") === (l ?? "") }))} /></label>
        <label className="flex items-center gap-2 text-[13px] font-medium text-muted">Type
          <Tabs items={[undefined, ...KINDS].map((k) => ({ href: link({ kind: k }), label: k ? k[0].toUpperCase() + k.slice(1) : "All", active: (kind ?? "") === (k ?? "") }))} /></label>
      </div>
      <Panel flush>
        <DataTable rows={rows} rowKey={(t) => t.id} empty="Nothing in this view."
          cols={[
            { h: "Ticket", cell: (t) => <Link className="hover:underline" href={`/admin/support/${t.id}`}>{t.no}<span className="block max-w-xs truncate text-[13px] font-normal text-muted">{t.subject}</span></Link> },
            { h: "Type", cell: (t) => <span className="capitalize">{t.kind}</span> },
            { h: "Business", cell: (t) => t.business },
            { h: "Level", align: "center", cell: (t) => t.level },
            { h: "Status", cell: (t) => <StatusPill status={t.status} /> },
            { h: "Resolve by", cell: (t) => { const late = t.slaBreachedAt || t.frBreachedAt; return <span className={late ? "font-semibold text-r-600" : ""}>{when(t.resolveDueAt)}{late && <span className="block text-xs">SLA missed</span>}</span>; } },
            { h: "", align: "right", cell: (t) => t.ombudsmanEscalatedAt && <span className="pill bg-r-100 text-r-600">Ombudsman</span> },
          ]} />
      </Panel>
    </>
  );
}
