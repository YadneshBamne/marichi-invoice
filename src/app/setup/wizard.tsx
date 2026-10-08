"use client";
import { useRef, useState, useTransition } from "react";
import { Icon, Logo } from "@/components/ui/icons";
import { Alert, Spinner } from "@/components/ui/forms";
import { ORG_ROLE_BLURB } from "@/server/permissions";
import { addTeamMember, finishSetup, saveApps, saveProfile } from "./actions";

type App = { id: string; name: string; icon: string; blurb: string; core: boolean; on: boolean };
type Soon = { slug: string; title: string; icon: string; phase: number; summary: string };
type Added = { name: string; email: string; password: string; orgRole: string };

const STEPS = ["Apps", "Company", "Team", "Finish"];
const INDUSTRIES = ["Manufacturing", "Textiles and apparel", "Food and agriculture", "Pharma and healthcare", "Electronics", "Logistics", "Construction", "Retail and distribution", "IT and services", "Other"];

export function SetupWizard({ type, firstName, legalName, hasLogo, catalog, soon, picked }: { type: string; firstName: string; legalName: string; hasLogo: boolean; catalog: App[]; soon: Soon[]; picked: string[] }) {
  const [step, setStep] = useState(0);
  const [sel, setSel] = useState(new Set(picked));
  const [name, setName] = useState(legalName);
  const [preview, setPreview] = useState<string | null>(null);
  const [team, setTeam] = useState<Added[]>([]);
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const appCount = catalog.filter((c) => c.core || sel.has(c.id)).length;
  const profile = useRef<HTMLFormElement>(null);
  const member = useRef<HTMLFormElement>(null);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const go = (n: number) => { setErr(""); setStep(n); window.scrollTo({ top: 0 }); };
  const run = (fn: () => Promise<{ ok: boolean; error?: string } | void>, next?: number) => start(async () => {
    setErr("");
    const r = await fn();
    if (r && !r.ok) return setErr(r.error ?? "Something went wrong.");
    if (next !== undefined) go(next);
  });

  const nextFromApps = () => run(() => saveApps([...sel]), 1);
  const nextFromProfile = () => {
    const f = profile.current!;
    if (!f.reportValidity()) return;
    run(() => saveProfile(new FormData(f)), 2);
  };
  const addOne = () => {
    const f = member.current!;
    if (!f.reportValidity()) return;
    const fd = new FormData(f);
    const p = { name: String(fd.get("name")), email: String(fd.get("email")), orgRole: String(fd.get("orgRole")) as "manager" | "member" };
    start(async () => {
      setErr("");
      const r = await addTeamMember(p);
      if (!r.ok) return setErr(r.error);
      setTeam((t) => [...t, { name: p.name, email: r.email, password: r.password, orgRole: p.orgRole }]);
      f.reset();
    });
  };

  return (
    <div className="min-h-dvh bg-page p-3 sm:p-4">
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] max-w-5xl flex-col rounded-panel bg-panel p-5 sm:min-h-[calc(100dvh-2rem)] sm:p-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <span className="flex items-center gap-3"><Logo className="h-10 w-10" /><span className="text-xl font-semibold tracking-tight">Marichi</span></span>
          <ol aria-label="Setup progress" className="flex items-center gap-2">
            {STEPS.map((s, n) => (
              <li key={s} className="flex items-center gap-2" aria-current={n === step ? "step" : undefined}>
                <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold transition-colors ${n < step ? "bg-p-700 text-white" : n === step ? "bg-p-800 text-white" : "bg-card text-faint ring-1 ring-hair"}`}>{n < step ? <Icon name="check" className="h-3.5 w-3.5" /> : n + 1}</span>
                <span className={`hidden text-[13px] font-medium sm:block ${n === step ? "text-ink" : "text-faint"}`}>{s}</span>
                {n < STEPS.length - 1 && <span className="hidden h-px w-6 bg-hair sm:block" />}
              </li>
            ))}
          </ol>
        </header>

        <main key={step} className="anim-up mx-auto mt-8 w-full max-w-4xl flex-1">
          {step === 0 && (
            <section>
              <h1 className="page-title">Welcome, {firstName}. What will your company use?</h1>
              <p className="page-sub max-w-2xl">Switch on the apps you need. You can add or remove them later from the Apps page.</p>
              <ul className="stagger mt-7 grid gap-4 sm:grid-cols-2">
                {catalog.map((a) => {
                  const on = a.core || sel.has(a.id);
                  return (
                    <li key={a.id}>
                      <button type="button" disabled={a.core} onClick={() => toggle(a.id)} aria-pressed={on}
                        className={`lift flex h-full w-full items-start gap-4 rounded-card bg-card p-5 text-left shadow-card transition-all ${on ? "ring-2 ring-p-700" : "ring-1 ring-transparent"} ${a.core ? "cursor-default" : ""}`}>
                        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${on ? "bg-p-700 text-white" : "bg-panel text-p-700"}`}><Icon name={a.icon} className="h-6 w-6" /></span>
                        <span className="flex-1"><span className="flex items-center gap-2 font-semibold">{a.name}{a.core && <span className="pill bg-p-100 text-p-700">Included</span>}</span><span className="mt-1 block text-[13.5px] text-muted">{a.blurb}</span></span>
                        <span className={`mt-1 grid h-6 w-6 place-items-center rounded-full ${on ? "bg-p-700 text-white" : "ring-1 ring-hair"}`}>{on && <Icon name="check" className="h-3.5 w-3.5" />}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <h2 className="mt-9 text-[15px] font-semibold">Coming soon <span className="font-normal text-muted">Follow the ones you want to hear about. They show in your menu as planned.</span></h2>
              <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {soon.map((s) => {
                  const on = sel.has(s.slug);
                  return (
                    <li key={s.slug}>
                      <button type="button" onClick={() => toggle(s.slug)} aria-pressed={on} className={`flex h-full w-full items-start gap-3 rounded-card bg-card/70 p-4 text-left text-sm transition-all ${on ? "ring-2 ring-p-600" : "ring-1 ring-hair hover:ring-p-400"}`}>
                        <Icon name={s.icon} className="mt-0.5 h-5 w-5 shrink-0 text-p-600" />
                        <span className="flex-1"><span className="flex items-center gap-2 font-semibold">{s.title}<span className="pill bg-panel text-muted">Phase {s.phase}</span></span><span className="mt-0.5 block text-[13px] text-muted">{s.summary}</span></span>
                        {on && <Icon name="check" className="h-4 w-4 shrink-0 text-p-700" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {step === 1 && (
            <section>
              <h1 className="page-title">Set up your company</h1>
              <p className="page-sub">This is how your workspace will appear to you and your team.</p>
              <form ref={profile} onSubmit={(e) => e.preventDefault()} className="mt-7 grid gap-6 rounded-card bg-card p-5 shadow-card sm:grid-cols-[auto_1fr] sm:p-7">
                <div className="flex flex-col items-center gap-3">
                  <label className="group relative grid h-32 w-32 cursor-pointer place-items-center overflow-hidden rounded-3xl bg-panel ring-2 ring-dashed ring-hair transition-all hover:ring-p-600">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {preview ? <img src={preview} alt="Company logo preview" className="h-full w-full object-cover" /> : (
                      <span className="text-center text-xs text-muted"><Icon name="upload" className="mx-auto mb-1 h-6 w-6 text-p-600" />{hasLogo ? "Replace logo" : "Upload logo"}</span>
                    )}
                    <input name="logo" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                      onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; if (f.size > 1024 * 1024) { setErr("The picture must be under 1 MB."); e.target.value = ""; return; } setErr(""); setPreview(URL.createObjectURL(f)); }} />
                  </label>
                  <p className="text-center text-xs text-faint">PNG, JPEG or WebP<br />under 1 MB. Optional.</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-medium sm:col-span-2">Company name<input name="name" required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} className="field font-normal" />
                    <span className="mt-1 block text-xs font-normal text-muted">Shown in the sidebar and headings across your workspace.</span></label>
                  <label className="block text-sm font-medium">Phone<input name="phone" type="tel" autoComplete="tel" className="field font-normal" placeholder="+91 98765 43210" /></label>
                  <label className="block text-sm font-medium">City<input name="city" className="field font-normal" /></label>
                  <label className="block text-sm font-medium sm:col-span-2">Industry
                    <select name="industry" defaultValue="" className="field font-normal"><option value="">Select (optional)</option>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</select></label>
                </div>
              </form>
            </section>
          )}

          {step === 2 && (
            <section>
              <h1 className="page-title">Add your team</h1>
              <p className="page-sub max-w-2xl">Create a login for each person. You set their first password, and they must replace it the first time they sign in. You can do this later from Settings, Team.</p>
              <div className="mt-7 grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
                <form ref={member} onSubmit={(e) => { e.preventDefault(); addOne(); }} className="space-y-4 rounded-card bg-card p-5 shadow-card sm:p-6">
                  <label className="block text-sm font-medium">Full name<input name="name" required minLength={2} className="field font-normal" /></label>
                  <label className="block text-sm font-medium">Work email<input name="email" type="email" required className="field font-normal" /></label>
                  <fieldset>
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
                  <button disabled={pending} className="btn btn-ghost w-full">{pending ? <Spinner /> : <Icon name="plus" className="h-4 w-4" />}Add person</button>
                </form>
                <div className="rounded-card bg-card p-5 shadow-card sm:p-6">
                  <h2 className="text-[15px] font-semibold">Added ({team.length})</h2>
                  {team.length === 0 ? <p className="mt-3 text-sm text-muted">Nobody yet. You can skip this and add people later.</p> : (
                    <ul className="mt-3 space-y-3">
                      {team.map((t) => (
                        <li key={t.email} className="anim-pop rounded-xl bg-panel p-3 text-sm">
                          <p className="font-semibold">{t.name} <span className="pill ml-1 bg-card text-muted capitalize ring-1 ring-hair">{t.orgRole}</span></p>
                          <p className="text-muted">{t.email}</p>
                          <p className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-card px-3 py-2 font-mono text-[13px]"><span>{t.password}</span>
                            <button type="button" className="font-sans text-xs font-semibold text-p-700 hover:underline" onClick={() => navigator.clipboard?.writeText(`${t.email}\n${t.password}`)}>Copy</button></p>
                        </li>
                      ))}
                    </ul>
                  )}
                  {team.length > 0 && <p className="mt-3 text-xs text-muted">Share these privately. They are shown only now, and each person must choose their own password at first sign-in.</p>}
                </div>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="mx-auto max-w-xl text-center">
              <span className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-p-700 text-white"><Icon name="check" className="h-8 w-8" /></span>
              <h1 className="page-title mt-5">{name} is ready</h1>
              <p className="page-sub">Your workspace has {appCount} app{appCount === 1 ? "" : "s"}{team.length ? ` and ${team.length} team member${team.length === 1 ? "" : "s"}` : ""} switched on.</p>
              <ul className="mx-auto mt-6 max-w-sm space-y-2 text-left text-sm">
                <li className="flex gap-3 rounded-xl bg-card p-3 shadow-card"><Icon name="shield" className="h-5 w-5 shrink-0 text-p-600" />{type === "buyer" ? "Verify your company so suppliers can be paid against your confirmations." : "Verify your business (KYB) to start getting offers."}</li>
                <li className="flex gap-3 rounded-xl bg-card p-3 shadow-card"><Icon name="play" className="h-5 w-5 shrink-0 text-p-600" />A short tour will show you around the first time.</li>
              </ul>
            </section>
          )}

          {err && <div className="mt-5"><Alert>{err}</Alert></div>}
        </main>

        <footer className="mx-auto mt-8 flex w-full max-w-4xl items-center justify-between gap-3">
          {step > 0 && step < 3 ? <button onClick={() => go(step - 1)} disabled={pending} className="btn btn-ghost">Back</button> : <span />}
          <div className="flex gap-3">
            {step === 2 && <button onClick={() => go(3)} disabled={pending} className="btn btn-ghost">Skip for now</button>}
            {step === 0 && <button onClick={nextFromApps} disabled={pending} className="btn btn-primary">{pending && <Spinner />}Continue</button>}
            {step === 1 && <button onClick={nextFromProfile} disabled={pending} className="btn btn-primary">{pending && <Spinner />}Continue</button>}
            {step === 2 && <button onClick={() => go(3)} disabled={pending} className="btn btn-primary">{team.length ? "Continue" : "Continue without team"}</button>}
            {step === 3 && <button onClick={() => run(() => finishSetup())} disabled={pending} className="btn btn-primary px-8">{pending && <Spinner />}Go to my workspace</button>}
          </div>
        </footer>
      </div>
    </div>
  );
}
