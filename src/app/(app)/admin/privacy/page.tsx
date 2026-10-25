import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { eraseAccount, erasureBlockers, KINDS, lastSweep, PRIVACY, queue, resolveRequest } from "@/server/privacy/service";
import { DataTable, Notice, PageHead, Panel, Pop, PopField, StatusPill } from "@/components/ui/page";
import { market } from "@/lib/countries";
import { attempt } from "../../financier/attempt";

export const metadata = { title: "Privacy requests" };
const PATH = "/admin/privacy";
const ROLES = ["admin", "compliance"] as const;

async function resolve(fd: FormData) {
  "use server";
  const u = await requireUser([...ROLES]);
  await attempt(PATH, async () => {
    await resolveRequest(db, u, z.uuid().parse(fd.get("id")), { outcome: fd.get("outcome") === "refused" ? "refused" : "completed", note: String(fd.get("note") ?? "") });
    return "Answered. The person has been told.";
  });
}
async function erase(fd: FormData) {
  "use server";
  const u = await requireUser([...ROLES]);
  await attempt(PATH, async () => { await eraseAccount(db, u, z.uuid().parse(fd.get("id"))); return "Account closed and the person's details removed."; });
}

export default async function PrivacyQueue({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["ops", ...ROLES]); // operations can see the queue; only admin and compliance can act on it
  const q = await searchParams;
  const [rows, sweep] = await Promise.all([queue(db), lastSweep(db)]);
  const blockers = new Map(await Promise.all(rows.filter((x) => x.r.status === "received" && x.r.kind === "erasure").map(async (x) => [x.r.id, await erasureBlockers(db, x.r.userId)] as const)));
  const p = market().privacy;
  return (
    <>
      <PageHead title="Privacy requests" sub={`People asking about their own data under ${p.law}. Each has a due date of ${PRIVACY.responseDays} days; copies are answered automatically.`} />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <Panel title={`${rows.filter((x) => x.r.status === "received").length} open`} flush className="mb-5">
        <DataTable rows={rows} rowKey={(x) => x.r.id} empty="No requests yet."
          cols={[
            { h: "Person", cell: (x) => <>{x.name}<span className="block text-xs font-normal text-muted">{x.email}</span></> },
            { h: "Request", cell: (x) => <>{KINDS[x.r.kind as keyof typeof KINDS] ?? x.r.kind}{x.r.details && <span className="block max-w-xs text-xs font-normal text-muted">{x.r.details}</span>}</> },
            { h: "Due", cell: (x) => <span className={x.overdue ? "font-semibold text-r-600" : "font-normal text-muted"}>{x.r.dueAt.toLocaleDateString("en-IN")}{x.overdue && " (overdue)"}</span> },
            { h: "Status", cell: (x) => <StatusPill status={x.r.status === "received" ? "pending" : x.r.status === "completed" ? "paid" : "rejected"} label={x.r.status === "received" ? "Open" : x.r.status === "completed" ? "Done" : "Declined"} /> },
            { h: "", align: "right", cell: (x) => x.r.status !== "received" ? <span className="max-w-xs text-xs font-normal text-muted">{x.r.resolution}</span> : (
              <span className="inline-flex flex-wrap justify-end gap-2">
                {x.r.kind === "erasure" && (
                  (blockers.get(x.r.id) ?? []).length
                    ? <span className="max-w-xs text-left text-xs font-normal text-s-600">Cannot delete yet: {(blockers.get(x.r.id) ?? []).join("; ")}</span>
                    : <form action={erase}><input type="hidden" name="id" value={x.r.id} /><button className="btn btn-primary btn-sm">Erase account</button></form>
                )}
                <Pop id={`answer-${x.r.id}`} label={x.r.kind === "erasure" ? "Decline" : "Answer"} cls="btn btn-ghost btn-sm">
                  <form action={resolve} className="space-y-2">
                    <input type="hidden" name="id" value={x.r.id} />
                    <PopField label="What was done, or why not (the person sees this)"><textarea name="note" rows={3} required className="field !py-2 text-sm font-normal" /></PopField>
                    {x.r.kind !== "erasure" && <button name="outcome" value="completed" className="btn btn-primary btn-sm w-full">Done</button>}
                    <button name="outcome" value="refused" className="btn btn-ghost btn-sm w-full">Decline</button>
                  </form>
                </Pop>
              </span>
            ) },
          ]} />
      </Panel>
      <Panel title="How long we keep things" sub="Housekeeping data is deleted every night. Regulated records are never swept.">
        <ul className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          <li>Verification, agreements, payments and the ledger: {p.retentionYears} years after the relationship ends</li>
          <li>Messages we sent: {PRIVACY.notificationDays} days</li>
          <li>Scheduled report files: {PRIVACY.reportRunDays} days</li>
          <li>Webhook records: {PRIVACY.webhookDays} days</li>
          <li>Technical call logs: {PRIVACY.logDays} days</li>
          <li>A data copy for download: {PRIVACY.exportDays} days</li>
        </ul>
        <p className="mt-3 text-xs text-muted">The last four are editable under Policy. {sweep ? `Last sweep ${sweep.at.toLocaleString("en-IN")}: ${Object.entries(sweep.counts).map(([k, v]) => `${v} ${k}`).join(", ")}.` : "No sweep has deleted anything yet."}</p>
      </Panel>
    </>
  );
}
