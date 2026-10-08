import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { systemHealth } from "@/server/admin/service";
import { POLICY } from "@/server/underwriting/policy";
import { OFFER } from "@/server/offers/pricing";
import { DISBURSE } from "@/server/disbursements/service";
import { COLLECTIONS } from "@/server/collections/waterfall";
import { RULES } from "@/server/invoices/service";
import { SLA_HOURS } from "@/server/support/policy";
import { gatewayStats } from "@/server/integrations/harden";
import { DataTable, KV, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatINR } from "@/lib/money";

export const metadata = { title: "System and policy" };

export default async function System() {
  await requireUser(["admin"]);
  const h = await systemHealth(db);
  const stale = !h.workerLastRun || Date.now() - h.workerLastRun.getTime() > 15 * 60_000;
  const policy: [string, string][] = [
    ["Max invoice age", `${RULES.maxAgeDays} days`], ["Invoice size", `${formatINR(RULES.minTicket)} to ${formatINR(RULES.maxTicket)}`],
    ["Tenor", `${POLICY.minTenorDays} to ${POLICY.maxTenorDays} days`], ["Minimum bureau score", String(POLICY.minBureauScore)],
    ["Seller limit", formatINR(POLICY.defaultSellerLimit)], ["Per-buyer cap", formatINR(POLICY.defaultBuyerCap)],
    ["Processing fee", `${OFFER.processingFeeBps / 100}% plus 18% GST`], ["Offer validity", `${OFFER.validityHours} hours`],
    ["Second approval above", formatINR(DISBURSE.approvalThreshold)],
    ["Grace period", `${COLLECTIONS.graceDays} days`], ["Penal rate", `${COLLECTIONS.penalBps / 100}% a year`], ["Written off after", `${COLLECTIONS.writeOffAfterDpd} days past due`],
  ];
  const grades = Object.entries(POLICY.matrix);
  const stats = Object.entries(gatewayStats()).map(([provider, s]) => ({ provider, ...s }));

  return (
    <>
      <PageHead title="System and policy" sub="Live health of the background worker, notifications, payouts and providers, and the policy values currently in force." />
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

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Policy values" sub="Read-only. Set in code today."><KV rows={policy} /></Panel>
        <div className="space-y-5">
          <Panel title="Pricing by grade" flush>
            <DataTable rows={grades} rowKey={([g]) => g} cols={[
              { h: "Grade", cell: ([g]) => g },
              { h: "Advance", align: "right", cell: ([, m]) => `${m.advanceBps / 100}%` },
              { h: "Discount p.a.", align: "right", cell: ([, m]) => `${m.discountBps / 100}%` },
              { h: "Auto-approve up to", align: "right", cell: ([, m]) => (m.autoMax > 0n ? formatINR(m.autoMax) : <span className="text-faint">manual</span>) },
            ]} />
          </Panel>
          <Panel title="Support timers" flush>
            <DataTable rows={Object.entries(SLA_HOURS)} rowKey={([k]) => k} cols={[
              { h: "Type", cell: ([k]) => <span className="capitalize">{k}</span> },
              { h: "First response", align: "right", cell: ([, s]) => `${s.firstResponse} h` },
              { h: "Resolve within", align: "right", cell: ([, s]) => `${s.resolve / 24} days` },
            ]} />
          </Panel>
        </div>
      </div>
    </>
  );
}
