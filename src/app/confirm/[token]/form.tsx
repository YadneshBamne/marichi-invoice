"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Alert, PasswordInput, SubmitButton, Spinner } from "@/components/ui/forms";
import { claim, decide, sendCode } from "./actions";

type View = { invoice: { number: string; amount: string; dueDate: string; invoiceDate: string; seller: string; buyer: string }; wording: string[]; dispute: string; clarify: string };
type Choice = "confirm" | "dispute" | "clarify";

const OUTCOME: Record<string, string> = {
  eligible: "Confirmed. Thank you. The supplier has been told, and you will pay the amount on the due date.",
  confirmed: "Confirmed. Thank you. The supplier has been told. We will review whether it can be financed.",
  disputed: "Recorded as disputed. The supplier and our support team have been told, and financing is paused.",
  clarification: "Your question has been sent to the supplier. The invoice stays open until you confirm or dispute it.",
};

export function ConfirmFlow({ token, v }: { token: string; v: View }) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "answer" | "done">("email");
  const [email, setEmail] = useState("");
  const [choice, setChoice] = useState<Choice>("confirm");
  const [result, setResult] = useState("");
  const [claimable, setClaimable] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [pw, setPw] = useState({ busy: false, err: "" });

  const ask = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr("");
    start(async () => { const r = await sendCode(token, email); if (!r.ok) return setErr(r.error); setStep("answer"); });
  };
  const answer = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr("");
    const code = String(new FormData(e.currentTarget).get("code"));
    start(async () => {
      const r = await decide(token, email, code, choice, note);
      if (!r.ok) return setErr(r.error);
      setResult(OUTCOME[r.status] ?? "Recorded. Thank you."); setClaimable(choice === "confirm"); setStep("done");
    });
  };
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setPw({ busy: true, err: "" });
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    if (password !== f.get("confirm")) return setPw({ busy: false, err: "The two passwords do not match." });
    const r = await claim(token, String(f.get("name")), password);
    if (!r.ok) return setPw({ busy: false, err: r.error });
    const { error } = await authClient.signIn.email({ email: r.email, password });
    if (error) return setPw({ busy: false, err: "Your account was created. Sign in to continue." });
    router.push("/dashboard");
  }

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 rounded-card bg-panel p-5 text-sm">
        <dt className="text-muted">Invoice</dt><dd className="font-semibold">{v.invoice.number}</dd>
        <dt className="text-muted">From</dt><dd>{v.invoice.seller}</dd>
        <dt className="text-muted">To</dt><dd>{v.invoice.buyer}</dd>
        <dt className="text-muted">Amount</dt><dd className="text-lg font-semibold">{v.invoice.amount}</dd>
        <dt className="text-muted">Dated</dt><dd>{v.invoice.invoiceDate}</dd>
        <dt className="text-muted">Due</dt><dd>{v.invoice.dueDate}</dd>
      </dl>

      {step === "email" && (
        <form onSubmit={ask} className="space-y-4">
          <p className="text-sm text-muted">To make sure this is you, we email a one-time code to the address this link was sent to. No account needed.</p>
          <label className="block text-sm font-medium">Your email address<input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="field font-normal" placeholder="you@company.com" /></label>
          {err && <Alert>{err}</Alert>}
          <SubmitButton pending={pending}>{pending ? "Sending" : "Email me a code"}</SubmitButton>
        </form>
      )}

      {step === "answer" && (
        <form onSubmit={answer} className="space-y-5">
          <p className="text-sm text-muted">If that address is on file, a code is on its way (it works for 10 minutes). Enter it below, then choose what to do.</p>
          <label className="block text-sm font-medium">Code from your email<input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="field text-center font-mono text-xl tracking-[.3em]" placeholder="000000" /></label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What would you like to do?</legend>
            {([["confirm", "Confirm this invoice"], ["dispute", "Dispute it"], ["clarify", "Ask a question"]] as const).map(([k, label]) => (
              <label key={k} className="flex cursor-pointer items-center gap-3 rounded-xl p-3 text-sm ring-1 ring-hair has-[:checked]:bg-p-100 has-[:checked]:ring-2 has-[:checked]:ring-p-700">
                <input type="radio" name="choice" checked={choice === k} onChange={() => setChoice(k)} /><b>{label}</b>
              </label>
            ))}
          </fieldset>
          {choice === "confirm" ? (
            <div className="rounded-card bg-panel p-5 text-sm">
              <p className="font-semibold">By pressing Confirm you agree that:</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5">{v.wording.map((w, i) => <li key={i}>{w}</li>)}</ol>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted">{choice === "dispute" ? v.dispute : v.clarify}</p>
              <textarea required value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="field font-normal" placeholder={choice === "dispute" ? "What is wrong with it?" : "What would you like to ask?"} />
            </div>
          )}
          {err && <Alert>{err}</Alert>}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={pending}>{pending && <Spinner />}{choice === "confirm" ? "Confirm invoice" : choice === "dispute" ? "Send dispute" : "Send question"}</button>
            <button type="button" className="text-sm font-semibold text-p-700 hover:underline" onClick={() => { setStep("email"); setErr(""); }}>Use a different address</button>
          </div>
        </form>
      )}

      {step === "done" && (
        <div className="space-y-5">
          <Alert tone="good">{result}</Alert>
          {claimable && (
            <form onSubmit={create} className="space-y-4 rounded-card bg-p-100 p-5 ring-1 ring-p-400">
              <div>
                <p className="font-semibold">Create your company account (optional)</p>
                <p className="mt-1 text-sm text-muted">See every invoice from your suppliers in one place, set up auto-pay and invite colleagues. It takes a minute and uses {email}.</p>
              </div>
              <label className="block text-sm font-medium">Your full name<input name="name" required minLength={2} autoComplete="name" className="field font-normal" /></label>
              <PasswordInput label="Choose a password" name="password" required minLength={10} autoComplete="new-password" />
              <PasswordInput label="Confirm password" name="confirm" required minLength={10} autoComplete="new-password" />
              {pw.err && <Alert>{pw.err}</Alert>}
              <SubmitButton pending={pw.busy}>{pw.busy ? "Creating" : "Create account"}</SubmitButton>
              <p className="text-xs text-muted">By creating an account you accept the <a className="font-semibold text-p-700 underline" href="/terms" target="_blank">terms</a> and <a className="font-semibold text-p-700 underline" href="/privacy" target="_blank">privacy notice</a>. This offer lasts about an hour. Later, ask your supplier to resend an invoice or use the invitation link.</p>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
