"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "@/components/ui/public";
import { Alert, PasswordInput, SubmitButton } from "@/components/ui/forms";
import { Icon } from "@/components/ui/icons";

const STEPS = ["Confirm password", "Scan and verify", "Save backup codes"];

export default function MfaSetup() {
  const router = useRouter();
  const [uri, setUri] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);
  const step = done ? 2 : uri ? 1 : 0;

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(""); setPending(true);
    const { data, error } = await authClient.twoFactor.enable({ password: String(new FormData(e.currentTarget).get("password")) });
    setPending(false);
    if (error || !data || data.method !== "totp") return setErr(error?.message ?? "Could not start setup. Check your password.");
    setUri(data.totpURI); setCodes(data.backupCodes);
  }
  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(""); setPending(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: String(new FormData(e.currentTarget).get("code")).replace(/\s/g, "") });
    setPending(false);
    if (error) return setErr(error.message ?? "That code is not valid. Check the time on your phone and try again.");
    setDone(true);
  }

  return (
    <AuthLayout wide title="Secure your account" sub="Two-factor authentication is required for every Marichi account.">
      <ol aria-label="Progress" className="mb-8 flex items-center gap-2">
        {STEPS.map((s, n) => (
          <li key={s} className="flex flex-1 items-center gap-2" aria-current={n === step ? "step" : undefined}>
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors ${n < step ? "bg-p-700 text-white" : n === step ? "bg-s-500 text-p-950" : "bg-panel text-faint"}`}>{n < step ? <Icon name="check" className="h-3.5 w-3.5" /> : n + 1}</span>
            <span className={`hidden text-[13px] font-medium sm:block ${n === step ? "text-ink" : "text-faint"}`}>{s}</span>
            {n < 2 && <span className="h-px flex-1 bg-hair"><span className={`block h-full bg-p-700 transition-all duration-500 ${n < step ? "w-full" : "w-0"}`} /></span>}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <form onSubmit={start} className="space-y-4">
          <p className="text-sm text-muted">You&apos;ll need an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password.</p>
          <PasswordInput label="Confirm your password" name="password" required autoComplete="current-password" autoFocus />
          {err && <Alert>{err}</Alert>}
          <SubmitButton pending={pending}>Continue</SubmitButton>
        </form>
      )}

      {step === 1 && (
        <form onSubmit={verify} className="space-y-5">
          <div className="flex flex-col items-center gap-4 rounded-card bg-page p-5 sm:flex-row sm:items-start">
            <div className="rounded-lg bg-white p-3 shadow-card"><QRCodeSVG value={uri} size={160} /></div>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
              <li>Open your authenticator app and add an account.</li>
              <li>Scan this code with the camera.</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
          </div>
          <label className="block text-sm font-medium">6-digit code<input name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="field text-center font-mono text-xl tracking-[.3em]" placeholder="000000" /></label>
          {err && <Alert>{err}</Alert>}
          <SubmitButton pending={pending}>Verify code</SubmitButton>
        </form>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <Alert tone="good">Two-factor authentication is on.</Alert>
          <div>
            <p className="text-sm font-medium">Your backup codes</p>
            <p className="mt-1 text-sm text-muted">Each code works once if you lose your phone. They are shown only now. Store them somewhere safe.</p>
            <ul className="mt-3 grid grid-cols-2 gap-2 rounded-card bg-page p-4 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
            <button type="button" className="mt-2 text-sm font-semibold text-p-700 hover:underline" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>Copy codes</button>
          </div>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5" />I have saved my backup codes.</label>
          <button disabled={!saved} onClick={() => router.push("/dashboard")} className="btn btn-primary w-full">Continue to Marichi</button>
        </div>
      )}
    </AuthLayout>
  );
}
