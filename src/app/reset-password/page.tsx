"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "@/components/ui/public";
import { Alert, PasswordInput, SubmitButton } from "@/components/ui/forms";

function Form() {
  const token = useSearchParams().get("token");
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");

  if (!token) return <Alert>This reset link is invalid or incomplete. <Link className="font-semibold underline" href="/forgot-password">Request a new one</Link>.</Alert>;
  if (done) return (
    <div className="space-y-4">
      <Alert tone="good">Your password has been changed. You can log in with it now.</Alert>
      <Link href="/login" className="btn btn-primary w-full">Go to log in</Link>
    </div>
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr("");
    const f = new FormData(e.currentTarget);
    if (f.get("next") !== f.get("confirm")) return setErr("The two passwords don't match.");
    setPending(true);
    const { error } = await authClient.resetPassword({ newPassword: String(f.get("next")), token: token! });
    setPending(false);
    if (error) return setErr(/token|expired|invalid/i.test(error.message ?? "") ? "This link has expired or was already used. Request a new one." : error.message ?? "Could not reset the password.");
    setDone(true);
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PasswordInput label="New password" name="next" required minLength={10} autoComplete="new-password" autoFocus />
      <PasswordInput label="Confirm new password" name="confirm" required minLength={10} autoComplete="new-password" />
      <p className="text-xs text-muted">At least 10 characters. You&apos;ll be signed out of every device.</p>
      {err && <Alert>{err}</Alert>}
      <SubmitButton pending={pending}>{pending ? "Saving" : "Set new password"}</SubmitButton>
    </form>
  );
}

export default function Reset() {
  return (
    <AuthLayout title="Choose a new password" footer={<Link className="font-semibold text-p-700 hover:underline" href="/login">Back to log in</Link>}>
      <Suspense><Form /></Suspense>
    </AuthLayout>
  );
}
