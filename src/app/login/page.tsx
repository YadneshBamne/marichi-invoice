"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "@/components/ui/public";
import { Alert, PasswordInput, SubmitButton } from "@/components/ui/forms";

export default function Login() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "totp">("password");
  const [backup, setBackup] = useState(false);
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);

  async function onPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(""); setPending(true);
    const fd = new FormData(e.currentTarget);
    const { data, error } = await authClient.signIn.email({ email: String(fd.get("email")), password: String(fd.get("password")) });
    setPending(false);
    if (error) return setErr(error.message ?? "Sign-in failed. Check your details and try again.");
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return setStep("totp");
    router.push("/dashboard"); // the guard sends people on to whatever they still owe: new password, two-factor, company setup
  }
  async function onCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(""); setPending(true);
    const code = String(new FormData(e.currentTarget).get("code")).replace(/\s/g, "");
    const { error } = backup ? await authClient.twoFactor.verifyBackupCode({ code }) : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setErr(error.message ?? "That code didn't work. Try again.");
    router.push("/dashboard");
  }

  return (
    <AuthLayout
      title={step === "password" ? "Welcome back" : "Two-step verification"}
      sub={step === "password" ? "Log in to your Marichi workspace." : backup ? "Enter one of your saved backup codes." : "Enter the 6-digit code from your authenticator app."}
      footer={step === "password" ? <>New to Marichi? <Link className="font-semibold text-p-700 hover:underline" href="/signup">Create an account</Link></> : null}
    >
      {step === "password" ? (
        <form onSubmit={onPassword} className="space-y-4">
          <label className="block text-sm font-medium">Work email<input name="email" type="email" required autoComplete="username" autoFocus className="field font-normal" placeholder="you@company.com" /></label>
          <PasswordInput label="Password" name="password" required autoComplete="current-password" hint={<Link href="/forgot-password" className="text-[13px] font-semibold text-p-700 hover:underline">Forgot password?</Link>} />
          {err && <Alert>{err}</Alert>}
          <SubmitButton pending={pending}>{pending ? "Signing in" : "Log in"}</SubmitButton>
        </form>
      ) : (
        <form onSubmit={onCode} className="space-y-4">
          <label className="block text-sm font-medium">{backup ? "Backup code" : "Authentication code"}
            <input name="code" required autoFocus autoComplete="one-time-code" inputMode={backup ? "text" : "numeric"} maxLength={backup ? 20 : 7}
              className="field text-center font-mono text-xl tracking-[.3em]" placeholder={backup ? "xxxxx-xxxxx" : "000000"} />
          </label>
          {err && <Alert>{err}</Alert>}
          <SubmitButton pending={pending}>{pending ? "Verifying" : "Verify and continue"}</SubmitButton>
          <div className="flex justify-between text-sm">
            <button type="button" onClick={() => { setBackup(!backup); setErr(""); }} className="font-semibold text-p-700 hover:underline">{backup ? "Use authenticator app" : "Use a backup code"}</button>
            <button type="button" onClick={() => { setStep("password"); setErr(""); setBackup(false); }} className="text-muted hover:text-ink">Back</button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
