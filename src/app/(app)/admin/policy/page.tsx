import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { DEF_BY_KEY, DEFS, display, listSettings, recentChanges, resetSetting, toInput, updateSettings } from "@/server/config/policy";
import { Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { market } from "@/lib/countries";

export const metadata = { title: "Policy" };

async function save(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  const note = String(fd.get("note") ?? "");
  const inputs: Record<string, string> = {};
  for (const d of DEFS) { const v = fd.get(d.key); if (typeof v === "string") inputs[d.key] = v; }
  try { await updateSettings(db, u, inputs, note); } catch (e) { redirect(`/admin/policy?error=${encodeURIComponent(e instanceof Error ? e.message : "Could not save")}`); }
  revalidatePath("/admin/policy");
  redirect("/admin/policy?saved=1");
}
async function reset(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  try { await resetSetting(db, u, String(fd.get("reset")), String(fd.get("note") ?? "")); } catch (e) { redirect(`/admin/policy?error=${encodeURIComponent(e instanceof Error ? e.message : "Could not reset")}`); }
  revalidatePath("/admin/policy");
  redirect("/admin/policy?saved=1");
}

const unit = (k: string) => (k === "percent" ? "%" : k === "rupees" ? "₹" : k === "hours" ? "hours" : "");

export default async function Policy({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireUser(["admin"]);
  const q = await searchParams;
  const [settings, changes] = await Promise.all([listSettings(db), recentChanges(db, 20)]);
  const groups = [...new Set(settings.map((s) => s.def.group))];
  const changedCount = settings.filter((s) => s.overridden).length;

  return (
    <>
      <PageHead title="Policy" sub="The numbers that decide pricing, limits, approvals, collections and support timers. Changes apply to every server within about 30 seconds, and each one needs a reason that is kept in the history." />
      {q.saved && <div className="mb-4"><Notice tone="good">Saved. The change is live and recorded in the history below.</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="mb-5"><Notice>{changedCount === 0 ? "Every value is at its built-in default." : `${changedCount} value${changedCount === 1 ? " differs" : "s differ"} from the built-in default.`} {market().tax.name} rates are set by law and cannot be edited here.</Notice></div>

      <form action={save} className="space-y-5">
        {groups.map((g) => (
          <Panel key={g} title={g} flush>
            <ul className="divide-y divide-hair">
              {settings.filter((s) => s.def.group === g).map(({ def: d, current, overridden }) => (
                <li key={d.key} className="grid items-center gap-x-6 gap-y-2 px-5 py-3.5 sm:grid-cols-[1fr_15rem_9rem] sm:px-6">
                  <div className="min-w-0">
                    <label htmlFor={d.key} className="text-sm font-medium">{d.label}</label>
                    {d.help && <p className="text-xs text-muted">{d.help}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {unit(d.kind) === "₹" && <span className="text-muted">₹</span>}
                    <input id={d.key} name={d.key} defaultValue={toInput(d, current)} inputMode="decimal" className="field-inline w-full text-right !py-1.5" />
                    {unit(d.kind) && unit(d.kind) !== "₹" && <span className="w-12 text-sm text-muted">{unit(d.kind)}</span>}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs sm:justify-end">
                    {overridden ? (<><StatusPill status="due" label="changed" /><button formAction={reset} formNoValidate name="reset" value={d.key} className="font-semibold text-p-700 hover:underline" title={`Default is ${display(d, d.fallback)}`}>Reset</button></>) : <span className="text-faint">default</span>}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        ))}

        <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-card bg-card p-4 shadow-pop">
          <input name="note" required minLength={5} placeholder="Reason for this change (kept in the history)" className="field-inline min-w-64 flex-1 !py-2" />
          <button className="btn btn-primary">Save changes</button>
        </div>
      </form>

      <Panel title="Change history" sub="Newest first" flush className="mt-5">
        {changes.length === 0 ? <p className="px-6 py-8 text-center text-sm text-muted">No changes have been made yet.</p> : (
          <ul className="divide-y divide-hair">
            {changes.map((c) => {
              const d = DEF_BY_KEY.get(c.key);
              const show = (v: unknown) => (v == null ? "default" : d ? display(d, typeof d.fallback === "bigint" ? BigInt(String(v)) : Number(v)) : String(v));
              return (
                <li key={c.id} className="px-5 py-3 text-sm sm:px-6">
                  <p className="font-medium">{d?.label ?? c.key} <span className="font-normal text-muted">{show(c.before)} to {show(c.after)}</span></p>
                  <p className="text-[13px] text-muted">{c.note} · {c.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} · {c.changedBy?.slice(0, 8)}</p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
