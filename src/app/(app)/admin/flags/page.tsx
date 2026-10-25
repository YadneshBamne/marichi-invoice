import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { FLAGS, listFlags, setFlag } from "@/server/flags/service";
import { market } from "@/lib/countries";
import { Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";

export const metadata = { title: "Feature flags" };

async function save(fd: FormData) {
  "use server";
  const u = await requireUser(["admin"]);
  const key = String(fd.get("key"));
  try {
    await setFlag(db, u, {
      key, enabled: fd.get("enabled") === "on", rolloutPct: Number(fd.get("rolloutPct")),
      early: String(fd.get("early") ?? "").split(/[\s,;]+/).filter(Boolean), note: String(fd.get("note") ?? ""),
    });
  } catch (e) { redirect(`/admin/flags?error=${encodeURIComponent(e instanceof Error ? e.message : "Could not save.")}`); }
  revalidatePath("/admin/flags");
  redirect("/admin/flags?saved=1");
}

export default async function Flags({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireUser(["admin"]);
  const q = await searchParams;
  const flags = await listFlags(db);
  const known = new Set<string>(FLAGS.map((f) => f.key));
  return (
    <>
      <PageHead title="Feature flags" sub="Switch a capability off for everyone, or roll it out step by step: to chosen companies first, then to a share of all companies." />
      {q.saved && <div className="mb-4"><Notice tone="good">Saved. Every server picks it up within 30 seconds.</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="grid gap-5">
        {flags.filter((f) => known.has(f.key)).map((f) => (
          <Panel key={f.key} title={<span className="flex items-center gap-2">{f.label}<StatusPill status={f.enabled ? "approved" : "rejected"} label={!f.enabled ? "off" : f.rolloutPct < 100 || f.onlyBusinesses.length ? "rolling out" : "on"} /></span>} sub={f.help}>
            <form action={save} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="key" value={f.key} />
              <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2"><input name="enabled" type="checkbox" defaultChecked={f.enabled} />On (turn this off to stop it for everyone)</label>
              <label className="block text-sm font-medium">Share of companies that get it (%)<input name="rolloutPct" type="number" min={0} max={100} defaultValue={f.rolloutPct} className="field font-normal" /></label>
              <label className="block text-sm font-medium">Companies that always get it<input name="early" placeholder={`${market().ids.taxReg.label}s, separated by commas`} className="field font-normal" />
                {f.onlyBusinesses.length > 0 && <span className="mt-1 block text-xs font-normal text-muted">Now: {f.onlyBusinesses.map((b) => b.name).join(", ")}. Entering numbers here replaces this list.</span>}</label>
              <label className="block text-sm font-medium sm:col-span-2">Reason for the change<input name="note" required minLength={5} defaultValue="" className="field font-normal" /></label>
              <div className="sm:col-span-2"><button className="btn btn-primary btn-sm">Save</button>{f.note && <span className="ml-3 text-xs text-muted">Last reason: {f.note}</span>}</div>
            </form>
          </Panel>
        ))}
      </div>
    </>
  );
}
