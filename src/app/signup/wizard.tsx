"use client";
import Link from "next/link";
import { startTransition, useActionState, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { Alert, PasswordInput, SubmitButton } from "@/components/ui/forms";
import { signUp, type SignUpState } from "./actions";

const TYPES = [
  { id: "seller", icon: "invoice", title: "Seller", d: "I supply goods or services and want to be paid sooner on my invoices." },
  { id: "buyer", icon: "building", title: "Buyer", d: "I buy from suppliers who finance their invoices with Marichi." },
  { id: "financier", icon: "bank", title: "Financier", d: "I am a licensed institution and want to deploy capital against confirmed invoices." },
] as const;
const ENTITIES = [["pvt_ltd", "Private limited company"], ["public_ltd", "Public limited company"], ["llp", "Limited liability partnership"], ["partnership", "Partnership firm"], ["proprietorship", "Sole proprietorship"], ["other", "Other"]];
const STEPS = ["Account type", "Your details", "Security"];

const rules = (p: string) => [
  { ok: p.length >= 10, t: "At least 10 characters" },
  { ok: /[a-z]/.test(p) && /[A-Z]/.test(p), t: "Upper and lower case letters" },
  { ok: /\d/.test(p), t: "A number" },
  { ok: /[^A-Za-z0-9]/.test(p), t: "A symbol" },
];

export function SignupWizard({ initialRole }: { initialRole?: "seller" | "buyer" | "financier" }) {
  const [state, action, pending] = useActionState<SignUpState, FormData>(signUp, {});
  const [step, setStep] = useState(initialRole ? 1 : 0); // coming from a front door, the role is already chosen
  const [role, setRole] = useState<string>(initialRole ?? "seller");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [local, setLocal] = useState("");
  const box = useRef<HTMLFormElement>(null);
  const r = rules(pw);
  const score = r.filter((x) => x.ok).length;

  // Every step stays mounted (so the whole form submits at once); Next validates only the visible step.
  const next = () => {
    const inputs = box.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-step="${step}"] input, [data-step="${step}"] select`) ?? [];
    for (const i of inputs) if (!i.reportValidity()) return;
    setLocal(""); setStep((s) => s + 1);
  };
  // Submitted by hand (not via the form's action) because React resets uncontrolled fields after an action, which would wipe the form on an error.
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pw !== confirm) return setLocal("The two passwords don't match.");
    if (score < 3) return setLocal("Choose a stronger password: meet at least three of the checks below.");
    setLocal("");
    const fd = new FormData(e.currentTarget);
    startTransition(() => action(fd));
  };

  return (
    <form onSubmit={submit} ref={box}>
      <ol aria-label="Progress" className="mb-8 flex items-center gap-2">
        {STEPS.map((s, n) => (
          <li key={s} className="flex flex-1 items-center gap-2" aria-current={n === step ? "step" : undefined}>
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors ${n < step ? "bg-p-700 text-white" : n === step ? "bg-s-500 text-p-950" : "bg-panel text-faint"}`}>{n < step ? <Icon name="check" className="h-3.5 w-3.5" /> : n + 1}</span>
            <span className={`hidden text-[13px] font-medium sm:block ${n === step ? "text-ink" : "text-faint"}`}>{s}</span>
            {n < STEPS.length - 1 && <span className="h-px flex-1 bg-hair"><span className={`block h-full bg-p-700 transition-all duration-500 ${n < step ? "w-full" : "w-0"}`} /></span>}
          </li>
        ))}
      </ol>

      <input type="hidden" name="role" value={role} />

      <div data-step="0" hidden={step !== 0} className="space-y-3">
        <p className="text-sm font-medium">What best describes you?</p>
        {TYPES.map((t) => {
          const on = role === t.id;
          return (
            <button key={t.id} type="button" disabled={"soon" in t} onClick={() => setRole(t.id)} aria-pressed={on}
              className={`flex w-full items-start gap-4 rounded-card p-4 text-left transition-all ${on ? "bg-p-100 ring-2 ring-p-700" : "bg-card ring-1 ring-hair hover:ring-p-400"} ${"soon" in t ? "cursor-not-allowed opacity-60" : "lift"}`}>
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${on ? "bg-p-700 text-white" : "bg-panel text-p-700"}`}><Icon name={t.icon} className="h-5 w-5" /></span>
              <span className="flex-1"><span className="flex items-center gap-2 font-semibold">{t.title}{"soon" in t && <span className="pill bg-panel text-muted">Coming soon</span>}</span><span className="mt-0.5 block text-[13.5px] text-muted">{t.d}</span></span>
              {on && <Icon name="check" className="mt-1 h-5 w-5 text-p-700" />}
            </button>
          );
        })}
        <button type="button" onClick={next} className="btn btn-primary mt-3 w-full">Continue<Icon name="arrow-right" className="h-4 w-4" /></button>
      </div>

      <div data-step="1" hidden={step !== 1} className="space-y-4">
        {initialRole && <p className="rounded-lg bg-p-100 px-4 py-2.5 text-sm text-p-800">Creating a <b>{TYPES.find((t) => t.id === role)?.title.toLowerCase()}</b> account. <button type="button" onClick={() => setStep(0)} className="font-semibold underline">Change</button></p>}
        <label className="block text-sm font-medium">Your full name<input name="name" required autoComplete="name" className="field font-normal" /></label>
        <label className="block text-sm font-medium">Work email<input name="email" type="email" required autoComplete="username" className="field font-normal" placeholder="you@company.com" /></label>
        <label className="block text-sm font-medium">Business legal name<input name="legalName" required className="field font-normal" placeholder={role === "financier" ? "The institution's registered name" : "As registered, e.g. Asha Traders Private Limited"} /></label>
        <label className="block text-sm font-medium">Entity type
          <select name="entityType" required defaultValue="" className="field font-normal"><option value="" disabled>Select</option>{ENTITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <div className="flex gap-3 pt-1"><button type="button" onClick={() => setStep(0)} className="btn btn-ghost">Back</button><button type="button" onClick={next} className="btn btn-primary flex-1">Continue<Icon name="arrow-right" className="h-4 w-4" /></button></div>
      </div>

      <div data-step="2" hidden={step !== 2} className="space-y-4">
        <PasswordInput label="Create a password" name="password" required minLength={10} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <div>
          <div className="flex gap-1.5" aria-hidden>{[0, 1, 2, 3].map((n) => <span key={n} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${n < score ? (score <= 2 ? "bg-r-600" : score === 3 ? "bg-s-500" : "bg-g-600") : "bg-panel"}`} />)}</div>
          <ul className="mt-2.5 grid gap-1 text-[13px] sm:grid-cols-2">{r.map((x) => <li key={x.t} className={`flex items-center gap-2 transition-colors ${x.ok ? "text-g-600" : "text-faint"}`}><Icon name={x.ok ? "check" : "close"} className="h-3.5 w-3.5" />{x.t}</li>)}</ul>
        </div>
        <PasswordInput label="Confirm password" name="confirm" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <label className="flex items-start gap-3 text-[13.5px] text-muted"><input name="terms" type="checkbox" required className="mt-0.5" />
          <span>I agree to the <Link href="/terms" target="_blank" className="font-semibold text-p-700 hover:underline">Terms of use</Link> and have read the <Link href="/privacy" target="_blank" className="font-semibold text-p-700 hover:underline">Privacy notice</Link>.</span>
        </label>
        {(local || state.error) && <Alert>{local || state.error}</Alert>}
        <div className="flex gap-3 pt-1"><button type="button" onClick={() => setStep(1)} className="btn btn-ghost">Back</button><SubmitButton pending={pending} className="flex-1">{pending ? "Creating account" : "Create account"}</SubmitButton></div>
        <p className="text-center text-xs text-faint">Next you will set up two-factor authentication, which is required on every account.</p>
      </div>
    </form>
  );
}
