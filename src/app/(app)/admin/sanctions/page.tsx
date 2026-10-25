import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { HIT_THRESHOLD } from "@/server/aml/screen";
import { refreshSanctionLists, sanctionsStatus, screenDetailed } from "@/server/aml/service";
import { DataTable, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { attempt } from "../../financier/attempt";

export const metadata = { title: "Sanctions lists" };
const PATH = "/admin/sanctions";
const NAMES = { ofac_sdn: "US OFAC SDN list", un: "UN Security Council consolidated list", eu: "EU consolidated list" } as Record<string, string>;
const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

async function reload() {
  "use server";
  await requireUser(["admin", "compliance"]);
  await attempt(PATH, async () => {
    const r = await refreshSanctionLists(db);
    const bad = r.filter((x) => !x.ok);
    if (bad.length) throw new Error(`Could not load ${bad.map((x) => `${x.list} (${x.error})`).join(", ")}. The other lists were updated.`);
    return `Loaded ${r.map((x) => `${x.entries} names from ${NAMES[x.list] ?? x.list}`).join(", ")}.`;
  });
}

export default async function Sanctions({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; name?: string }> }) {
  const u = await requireUser(["ops", "admin", "compliance"]);
  const q = await searchParams;
  const name = z.string().trim().max(200).safeParse(q.name ?? "").data ?? "";
  const status = await sanctionsStatus(db);
  let matches: Awaited<ReturnType<typeof screenDetailed>> = [], failure = "";
  if (name) { try { matches = await screenDetailed(db, name, { limit: 10 }); } catch (e) { failure = (e as Error).message; } }
  const real = process.env.AML_PROVIDER === "local";
  return (
    <>
      <PageHead title="Sanctions lists" sub="The public lists every company and owner is checked against. They are free, and refreshed every night." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      {!real && <div className="mb-4"><Notice tone="warn">Screening is still on the built-in test answers. Load the lists, then set AML_PROVIDER=local to use these lists for real.</Notice></div>}
      <Panel title="Lists" flush className="mb-5" action={u.role !== "ops" && <form action={reload}><button className="btn btn-primary btn-sm">Reload now</button></form>}>
        <DataTable rows={status} rowKey={(s) => s.list}
          cols={[
            { h: "List", cell: (s) => NAMES[s.list] ?? s.list },
            { h: "Names", align: "right", cell: (s) => s.entries.toLocaleString("en-IN") },
            { h: "Last loaded", cell: (s) => <span className="font-normal text-muted">{when(s.loadedAt)}</span> },
            { h: "Status", cell: (s) => <StatusPill status={!s.loadedAt || s.stale ? "rejected" : "approved"} label={!s.loadedAt ? "not loaded" : s.stale ? "stale: screening is blocked" : "fresh"} /> },
          ]} />
      </Panel>
      <Panel title="Check a name" sub={`A score of ${HIT_THRESHOLD} or more counts as a hit and goes to a compliance review. Lower scores are shown so you can judge them.`}>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2 text-sm">
          <label className="text-xs font-medium">Name of a person or company<input name="name" defaultValue={name} className="field-inline !py-1.5" size={36} /></label>
          <button className="btn btn-ghost btn-sm">Check</button>
        </form>
        {failure && <Notice tone="bad">{failure}</Notice>}
        {name && !failure && (matches.length === 0 ? <p className="text-sm text-muted">No similar names on the lists.</p> : (
          <DataTable rows={matches} rowKey={(m) => `${m.list}:${m.externalId}:${m.matchedName}`}
            cols={[
              { h: "Score", align: "right", cell: (m) => <span className={m.score >= HIT_THRESHOLD ? "font-semibold text-r-600" : ""}>{m.score}</span> },
              { h: "Listed as", cell: (m) => <>{m.listedName}{m.viaAlias && <span className="block text-xs font-normal text-muted">matched on the alias {m.matchedName}</span>}</> },
              { h: "List", cell: (m) => NAMES[m.list] ?? m.list },
              { h: "Programme", cell: (m) => <span className="font-normal text-muted">{m.program ?? ""}{m.country ? ` (${m.country})` : ""}</span> },
            ]} />
        ))}
      </Panel>
    </>
  );
}
