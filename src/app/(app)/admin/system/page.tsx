import Link from "next/link";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { systemHealth } from "@/server/admin/service";
import { gatewayStats } from "@/server/integrations/harden";
import { DataTable, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";

export const metadata = { title: "System health" };

export default async function System() {
  await requireUser(["admin"]);
  const h = await systemHealth(db);
  const stale = !h.workerLastRun || Date.now() - h.workerLastRun.getTime() > 15 * 60_000;
  const stats = Object.entries(gatewayStats()).map(([provider, s]) => ({ provider, ...s }));

  return (
    <>
      <PageHead title="System health" sub="Live health of the background worker, notifications, payouts and providers." />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat hero label="Background worker" value={stale ? "Not running" : "Running"} note={h.workerLastRun ? `last job ${h.workerLastRun.toISOString().slice(0, 16).replace("T", " ")}` : "no job has run yet"} tone={stale ? "bad" : undefined} />
        <Stat label="Notifications failed" value={String(h.failedNotifs)} note={`${h.queued} queued · ${h.stuckNotifs} stuck`} tone={h.failedNotifs ? "bad" : "good"} />
        <Stat label="Payouts failed" value={String(h.failedPayouts)} note={`${h.awaitingApproval} awaiting approval`} tone={h.failedPayouts ? "bad" : "good"} />
        <Stat label="Provider calls, 24 h" value={String(h.calls24h)} note={`${h.integrationsMode} mode · recon gate ${h.reconGate ? "on" : "off"}`} />
      </div>

      <Panel title="Provider calls" sub="This server process since it started" flush className="mb-5">
        <DataTable rows={stats} rowKey={(s) => s.provider} empty="No provider calls yet."
          cols={[
            { h: "Provider", cell: (s) => <span className="capitalize">{s.provider}</span> },
            { h: "Calls", align: "right", cell: (s) => s.calls },
            { h: "Errors", align: "right", cell: (s) => <span className={s.errors ? "font-semibold text-r-600" : ""}>{s.errors}</span> },
            { h: "Avg / max ms", align: "right", cell: (s) => `${s.calls ? Math.round(s.totalMs / s.calls) : 0} / ${s.maxMs}` },
            { h: "Circuit", cell: (s) => <StatusPill status={s.circuit === "open" ? "failed" : "paid"} label={s.circuit} /> },
            { h: "Last error", cell: (s) => <span className="font-normal text-muted">{s.lastError ?? "–"}</span> },
          ]} />
      </Panel>

      <Panel title="Policy values" sub="Pricing, limits, approvals, collections and support timers."><p className="text-sm text-muted">These are now editable, with a reason and a history for every change. <Link className="font-semibold text-p-700 underline" href="/admin/policy">Open Policy</Link></p></Panel>
    </>
  );
}
