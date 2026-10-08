"use client";
import { useRef, useState, useTransition } from "react";
import { Alert, Spinner } from "@/components/ui/forms";
import { Icon } from "@/components/ui/icons";
import { Card } from "@/components/ui/cards";
import { ORG_ROLE_BLURB } from "@/server/permissions";
import { add, changeRole, resetPassword, suspend } from "./actions";

export type Person = { id: string; name: string; email: string; orgRole: string | null; suspended: boolean; mustChange: boolean; you: boolean };
type Cred = { who: string; email: string; password: string };

const ROLE_PILL: Record<string, string> = { owner: "bg-p-700 text-white", manager: "bg-p-100 text-p-700", member: "bg-panel text-muted" };

export function TeamManager({ people, manage }: { people: Person[]; manage: boolean }) {
  const [err, setErr] = useState("");
  const [cred, setCred] = useState<Cred | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const run = (id: string, fn: () => Promise<{ ok: boolean; error?: string; password?: string; email?: string }>, who?: string) => {
    setErr(""); setBusy(id);
    start(async () => {
      const r = await fn();
      setBusy(null);
      if (!r.ok) { setErr(r.error ?? "Something went wrong."); return; }
      if (r.password && who) setCred({ who, email: r.email ?? "", password: r.password });
    });
  };

  return (
    <div className="space-y-5">
      {err && <Alert>{err}</Alert>}
      {cred && (
        <div className="anim-pop rounded-card bg-p-100 p-5 ring-1 ring-p-400">
          <p className="font-semibold">Credentials for {cred.who}</p>
          <p className="mt-1 text-sm text-muted">Share these privately. They are shown only now. {cred.who.split(" ")[0]} must choose a new password at first sign-in.</p>
          <p className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 font-mono text-sm shadow-card">
            {cred.email && <span>{cred.email}</span>}<span className="font-semibold">{cred.password}</span>
            <button className="ml-auto font-sans text-sm font-semibold text-p-700 hover:underline" onClick={() => navigator.clipboard?.writeText(`${cred.email}\n${cred.password}`)}>Copy</button>
            <button className="font-sans text-sm text-muted hover:text-ink" onClick={() => setCred(null)}>Dismiss</button>
          </p>
        </div>
      )}

      <Card title={`People (${people.length})`}>
        <ul className="divide-y divide-hair">
          {people.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-3.5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-s-100 text-[13px] font-bold text-s-600">{p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-semibold">{p.name}{p.you && <span className="text-xs font-normal text-faint">(you)</span>}
                  <span className={`pill capitalize ${ROLE_PILL[p.orgRole ?? "owner"]}`}>{p.orgRole ?? "owner"}</span>
                  {p.suspended && <span className="pill bg-r-100 text-r-600">Suspended</span>}
                  {p.mustChange && !p.suspended && <span className="pill bg-s-100 text-s-600">Has not signed in yet</span>}
                </span>
                <span className="block truncate text-[13px] text-muted">{p.email}</span>
              </span>
              {manage && p.orgRole !== "owner" && !p.you && (
                <span className="flex flex-wrap items-center gap-2">
                  <select aria-label={`Role for ${p.name}`} defaultValue={p.orgRole ?? "member"} disabled={pending} className="field-inline !py-1.5 text-sm"
                    onChange={(e) => run(p.id, () => changeRole(p.id, e.target.value as "manager" | "member"))}><option value="manager">Manager</option><option value="member">Member</option></select>
                  <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(p.id, () => resetPassword(p.id), p.name)}>{busy === p.id && <Spinner />}Reset password</button>
                  <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(p.id, () => suspend(p.id, !p.suspended))}>{p.suspended ? "Reactivate" : "Suspend"}</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {manage ? (
        <Card title="Add a person">
          <form ref={form} className="grid gap-4 lg:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const p = { name: String(fd.get("name")), email: String(fd.get("email")), orgRole: String(fd.get("orgRole")) as "manager" | "member" };
            run("add", async () => { const r = await add(p); if (r.ok) form.current?.reset(); return r; }, p.name);
          }}>
            <label className="block text-sm font-medium">Full name<input name="name" required minLength={2} className="field font-normal" /></label>
            <label className="block text-sm font-medium">Work email<input name="email" type="email" required className="field font-normal" /></label>
            <fieldset className="lg:col-span-3">
              <legend className="text-sm font-medium">Role</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(["manager", "member"] as const).map((r, n) => (
                  <label key={r} className="flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-hair transition-all has-[:checked]:bg-p-100 has-[:checked]:ring-2 has-[:checked]:ring-p-700">
                    <input type="radio" name="orgRole" value={r} defaultChecked={n === 1} className="mt-1" />
                    <span className="text-sm"><b className="capitalize">{r}</b><span className="mt-0.5 block text-xs text-muted">{ORG_ROLE_BLURB[r]}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="lg:col-span-3"><button disabled={pending} className="btn btn-primary">{busy === "add" ? <Spinner /> : <Icon name="plus" className="h-4 w-4" />}Create login</button>
              <span className="ml-3 text-xs text-muted">We generate a one-time password for you to hand over.</span></div>
          </form>
        </Card>
      ) : <p className="text-sm text-muted">Only the company owner can add or change people.</p>}
    </div>
  );
}
