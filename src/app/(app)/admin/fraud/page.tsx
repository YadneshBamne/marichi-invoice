import Link from "next/link";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { addCaseNote, assignCase, fileStr, listCases, resolveCase } from "@/server/fraud/service";
import { EmptyState, KV, PageHead, ReviewCard, StatusPill, Tabs } from "@/components/ui/page";
import { formatMoney } from "@/lib/money";

export const metadata = { title: "Fraud cases" };

const act = z.object({
  caseId: z.uuid(),
  action: z.enum(["assign", "note", "clear", "fraud", "file_str"]),
  note: z.string().default(""),
});

async function handle(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "compliance", "admin"]);
  const f = act.parse(Object.fromEntries(fd));
  const staff = { id: u.id, role: u.role };
  if (f.action === "assign") await assignCase(db, f.caseId, staff);
  else if (f.action === "note") await addCaseNote(db, f.caseId, staff, f.note);
  else if (f.action === "file_str") await fileStr(db, { caseId: f.caseId, reference: f.note, staff });
  else await resolveCase(db, { caseId: f.caseId, staff, outcome: f.action === "clear" ? "cleared" : "confirmed_fraud", note: f.note });
  revalidatePath("/admin/fraud");
}

const ago = (d: Date) => { const h = Math.floor((Date.now() - d.getTime()) / 3_600_000); return h < 1 ? "just now" : h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`; };
const SEV: Record<string, string> = { high: "bg-r-100 text-r-600", medium: "bg-s-100 text-s-600", low: "bg-panel text-muted" };

export default async function FraudQueue({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const u = await requireUser(["ops", "compliance", "admin"]);
  const status = (await searchParams).status === "closed" ? "closed" : "open";
  const cases = await listCases(db, status);
  const canResolve = ["compliance", "admin"].includes(u.role);

  return (
    <>
      <PageHead title="Fraud and compliance cases" sub="An open case freezes its invoice until a reviewer clears it or confirms fraud.">
        <Tabs items={[{ href: "?status=open", label: "Open", active: status === "open" }, { href: "?status=closed", label: "Closed", active: status === "closed" }]} />
      </PageHead>
      {cases.length === 0 ? <EmptyState title={`No ${status} cases`}>{status === "open" ? "Nothing is flagged right now." : "Closed cases will be listed here."}</EmptyState> : (
        <div className="space-y-5">
          {cases.map((c) => (
            <ReviewCard key={c.id}
              title={c.ruleTriggered.replaceAll("_", " ")}
              meta={<><span className={`pill capitalize ${SEV[c.severity]}`}>{c.severity}</span><span>Opened {ago(c.createdAt)}</span>{c.assignedTo && <span>· assigned</span>}{c.invoice && c.status === "open" && <StatusPill status="failed" label="invoice frozen" />}</>}
              actions={c.status === "open" ? (
                <form action={handle} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="caseId" value={c.id} />
                  <input name="note" placeholder="Note or resolution (required to resolve)" className="field-inline min-w-52 flex-1 !py-1.5 text-sm" />
                  <button name="action" value="assign" formNoValidate className="btn btn-ghost btn-sm">Assign to me</button>
                  <button name="action" value="note" className="btn btn-ghost btn-sm">Add note</button>
                  {canResolve && c.ruleTriggered !== "kyb_aml_hit" && (<>
                    <button name="action" value="clear" className="btn btn-primary btn-sm">Clear and release</button>
                    <button name="action" value="fraud" className="btn btn-danger btn-sm">Confirm fraud</button>
                  </>)}
                </form>
              ) : undefined}>
              <KV rows={[
                ...(c.invoice ? [["Invoice", `${c.invoice.number} · ${formatMoney(c.invoice.amount)}`], ["Parties", `${c.invoice.seller} → ${c.invoice.buyer}`], ["Invoice status", c.invoice.status.replaceAll("_", " ")]] as [string, string][] : []),
                ...(c.subjectName ? [["Subject", c.subjectName]] as [string, string][] : []),
                ...(c.status === "closed" ? [["Outcome", <b key="o" className="capitalize">{String(c.outcome).replaceAll("_", " ")}</b>], ["Resolution", c.resolution ?? ""]] as [string, React.ReactNode][] : []),
              ]} />
              {c.entityType === "business" && c.ruleTriggered === "kyb_aml_hit" && <p className="mt-3"><Link className="font-semibold text-p-700 underline" href="/admin/kyb">Resolve in the KYB review queue</Link></p>}
              {Array.isArray((c.details as { signals?: unknown[] } | null)?.signals) && (
                <div className="mt-3 rounded-lg bg-panel p-4">
                  <p className="text-xs font-semibold tracking-wide text-faint uppercase">Why it was flagged{(c.details as { score?: number }).score !== undefined && ` (score ${(c.details as { score: number }).score})`}</p>
                  <ul className="mt-2 space-y-2">
                    {((c.details as { signals: { rule: string; label: string; severity: string; score: number }[] }).signals).map((s) => (
                      <li key={s.rule} className="flex items-start justify-between gap-3 text-sm"><span><b className="font-semibold">{s.label}</b></span><span className="flex shrink-0 items-center gap-2"><span className={`pill capitalize ${SEV[s.severity] ?? SEV.low}`}>{s.severity}</span><span className="text-muted">+{s.score}</span></span></li>
                    ))}
                  </ul>
                </div>
              )}
              {c.details != null && !Array.isArray((c.details as { signals?: unknown[] }).signals) && <pre className="mt-3 overflow-x-auto rounded-lg bg-panel p-3 text-xs text-muted">{JSON.stringify(c.details, null, 2)}</pre>}
              {c.notes.length > 0 && (<><p className="mt-4 text-xs font-semibold tracking-wide text-faint uppercase">Notes</p><ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted">{c.notes.map((n) => <li key={n.id}>{n.note}</li>)}</ul></>)}
              {c.status === "closed" && c.str && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-panel p-3">
                  <span>STR <StatusPill status={c.str.status === "filed" ? "paid" : "pending"} label={c.str.status} />{c.str.reference && <span className="ml-2 text-muted">{c.str.reference}</span>}</span>
                  {c.str.status === "draft" && canResolve && (
                    <form action={handle} className="flex flex-wrap gap-2">
                      <input type="hidden" name="caseId" value={c.id} />
                      <input name="note" placeholder="Regulator reference no." required className="field-inline !py-1 text-sm" />
                      <button name="action" value="file_str" className="btn btn-ghost btn-sm">Mark as filed</button>
                    </form>
                  )}
                </div>
              )}
            </ReviewCard>
          ))}
        </div>
      )}
    </>
  );
}
