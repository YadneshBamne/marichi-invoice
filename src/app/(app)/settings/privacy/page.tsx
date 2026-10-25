import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { KINDS, keptNote, myRequests, openRequest, PRIVACY } from "@/server/privacy/service";
import { Field, Notice, Panel, StatusPill } from "@/components/ui/page";
import { market } from "@/lib/countries";
import { attempt } from "../../financier/attempt";

export const metadata = { title: "Privacy" };
const PATH = "/settings/privacy";

async function ask(fd: FormData) {
  "use server";
  const u = await requireUser();
  await attempt(PATH, async () => {
    const kind = z.string().parse(fd.get("kind"));
    const r = await openRequest(db, { id: u.id, role: u.role }, { kind, details: String(fd.get("details") ?? "") });
    return r.status === "completed" ? "Your copy is ready below." : `We received your request. We will answer by ${r.dueAt.toLocaleDateString("en-IN")}.`;
  });
}

export default async function Privacy({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser();
  const q = await searchParams;
  const mine = await myRequests(db, u.id);
  const p = market().privacy;
  return (
    <div className="space-y-5 text-sm">
      {q.ok && <Notice tone="good">{q.ok}</Notice>}
      {q.error && <Notice tone="bad">{q.error}</Notice>}
      <Panel title="Your data" sub={`Under ${p.law} you can see what we hold about you and ask us to change or delete it.`}>
        <form action={ask} className="grid gap-3 sm:max-w-xl">
          <Field label="What would you like?">
            <select name="kind" className="field" defaultValue="access">
              {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
          <Field label="Details" hint="Needed to correct something or stop a use. Optional otherwise.">
            <textarea name="details" rows={3} maxLength={2000} className="field" placeholder="For example: my phone number is wrong, it should be ..." />
          </Field>
          <div><button className="btn btn-primary btn-sm">Send request</button></div>
        </form>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-muted">
          <li>A copy of your data is ready straight away. Everything else we answer within {PRIVACY.responseDays} days.</li>
          <li>{keptNote()}</li>
          <li>If you are the only owner of a company with open financing, we cannot close your account until that is finished.</li>
          <li>Not satisfied with our answer? You can complain to {p.regulator}.</li>
        </ul>
      </Panel>
      <Panel title="Your requests" flush>
        {mine.length === 0 ? <p className="p-5 text-muted">You have not made any requests.</p> : (
          <ul className="divide-y divide-hair">
            {mine.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">{KINDS[r.kind as keyof typeof KINDS] ?? r.kind}</p>
                  <p className="text-xs text-muted">Asked {r.createdAt.toLocaleDateString("en-IN")}{r.status === "received" ? `, answer due ${r.dueAt.toLocaleDateString("en-IN")}` : ""}</p>
                  {r.resolution && <p className="mt-1 max-w-prose text-muted">{r.resolution}</p>}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <StatusPill status={r.status === "received" ? "pending" : r.status === "completed" ? "paid" : "rejected"} label={r.status === "received" ? "Open" : r.status === "completed" ? "Done" : "Declined"} />
                  {r.exportData != null && <a className="btn btn-ghost btn-sm" href={`/api/privacy/${r.id}`}>Download my data</a>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
