import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { setApps } from "@/server/company/service";
import { can } from "@/server/permissions";
import { appsFor } from "@/lib/apps";
import { roadmapFor } from "@/lib/roadmap";
import { Icon } from "@/components/ui/icons";
import { PageHead } from "@/components/ui/cards";

export const metadata = { title: "Apps" };

async function toggle(fd: FormData) {
  "use server";
  const u = await requireUser(["seller", "buyer", "financier"]);
  const f = z.object({ id: z.string(), on: z.enum(["1", "0"]) }).parse(Object.fromEntries(fd));
  const next = new Set(u.biz?.apps ?? []);
  if (f.on === "1") next.add(f.id); else next.delete(f.id);
  await setApps(db, { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId }, [...next]);
  revalidatePath("/", "layout"); // the sidebar changes with it
}

export default async function Apps() {
  const u = await requireUser(["seller", "buyer", "financier"]);
  const manage = can(u, "apps.manage");
  const picked = new Set(u.biz?.apps ?? []);
  const mine = appsFor(u.role);
  const installed = (id: string, core?: boolean) => core || u.apps.has(id);
  const soon = roadmapFor(u.role);

  const Btn = ({ id, on, label, danger }: { id: string; on: boolean; label: string; danger?: boolean }) => (
    <form action={toggle}><input type="hidden" name="id" value={id} /><input type="hidden" name="on" value={on ? "1" : "0"} /><button className={`btn btn-sm ${danger ? "btn-ghost" : "btn-primary"}`}>{label}</button></form>
  );

  return (
    <>
      <PageHead title="Apps" sub={manage ? "Switch on what your company uses. Changes apply to everyone straight away." : "The apps your company owner has switched on."} />
      <ul className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {mine.map((a) => {
          const on = installed(a.id, a.core);
          return (
            <li key={a.id} className="lift flex flex-col rounded-card bg-card p-5 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <span className={`grid h-12 w-12 place-items-center rounded-2xl ${on ? "bg-p-700 text-white" : "bg-panel text-p-700"}`}><Icon name={a.icon} className="h-6 w-6" /></span>
                <span className={`pill ${on ? "bg-g-100 text-g-600" : "bg-panel text-muted"}`}>{a.core ? "Included" : on ? "Installed" : "Not installed"}</span>
              </div>
              <h2 className="mt-4 text-[17px] font-semibold tracking-tight">{a.name}</h2>
              <p className="mt-1 flex-1 text-[13.5px] text-muted">{a.blurb}</p>
              <div className="mt-4 flex min-h-[34px] items-center">
                {a.core ? <span className="text-xs text-faint">Always on</span> : manage ? (on ? <Btn id={a.id} on={false} label="Remove" danger /> : <Btn id={a.id} on label="Install" />) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <h2 className="mt-10 mb-3 text-[15px] font-semibold">Coming soon</h2>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {soon.map((s) => {
          const follow = picked.has(s.slug);
          return (
            <li key={s.slug} className="flex flex-col rounded-card bg-card/70 p-5 ring-1 ring-hair">
              <div className="flex items-start justify-between gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-panel text-p-700"><Icon name={s.icon} className="h-5 w-5" /></span><span className="pill bg-panel text-muted">Phase {s.phase}</span></div>
              <h3 className="mt-3 font-semibold">{s.title}</h3>
              <p className="mt-1 flex-1 text-[13.5px] text-muted">{s.summary}</p>
              <div className="mt-4 flex items-center gap-3"><a className="text-sm font-semibold text-p-700 hover:underline" href={`/soon/${s.slug}`}>Details</a>{manage && <Btn id={s.slug} on={!follow} label={follow ? "Following" : "Follow"} danger={follow} />}</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
