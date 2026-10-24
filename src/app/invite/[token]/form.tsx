"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Alert, PasswordInput, SubmitButton } from "@/components/ui/forms";
import { joinAsExisting, joinAsNew } from "./actions";

/** New person: choose a name and a password. Nobody else ever sees them. */
export function JoinNew({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr("");
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    if (password !== f.get("confirm")) return setErr("The two passwords do not match.");
    setPending(true);
    const r = await joinAsNew(token, String(f.get("name")), password);
    if (!r.ok) { setPending(false); return setErr(r.error); }
    const { error } = await authClient.signIn.email({ email: r.email, password });
    setPending(false);
    if (error) return setErr("Your account was created. Sign in to continue.");
    router.push("/dashboard"); // the guard sends a new person on to two-step verification
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm font-medium">Email<input value={email} readOnly className="field bg-panel font-normal" /></label>
      <label className="block text-sm font-medium">Your full name<input name="name" required minLength={2} autoComplete="name" autoFocus className="field font-normal" /></label>
      <PasswordInput label="Choose a password" name="password" required minLength={10} autoComplete="new-password" hint="At least 10 characters. Only you will know it." />
      <PasswordInput label="Confirm password" name="confirm" required minLength={10} autoComplete="new-password" />
      <label className="flex items-start gap-3 text-[13.5px] text-muted"><input type="checkbox" required className="mt-0.5" />I accept the <a className="font-semibold text-p-700 underline" href="/terms" target="_blank">terms</a> and the <a className="font-semibold text-p-700 underline" href="/privacy" target="_blank">privacy notice</a>.</label>
      {err && <Alert>{err}</Alert>}
      <SubmitButton pending={pending}>{pending ? "Creating your account" : "Create account and join"}</SubmitButton>
      <p className="text-xs text-muted">Next you will set up two-step verification, which every Marichi account needs.</p>
    </form>
  );
}

/** Existing account, already signed in as the invited address. */
export function JoinExisting({ token, company }: { token: string; company: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="space-y-4">
      {err && <Alert>{err}</Alert>}
      <button className="btn btn-primary w-full" disabled={pending} onClick={async () => {
        setErr(""); setPending(true);
        const r = await joinAsExisting(token);
        if (!r.ok) { setPending(false); return setErr(r.error); }
        router.push("/dashboard");
      }}>{pending ? "Joining" : `Join ${company}`}</button>
      <p className="text-xs text-muted">{company} is added to your account. You can switch between your companies from the account menu.</p>
    </div>
  );
}
