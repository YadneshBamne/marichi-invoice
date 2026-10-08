"use client";
import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "@/components/ui/public";
import { Alert, SubmitButton } from "@/components/ui/forms";

export default function Forgot() {
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(""); setPending(true);
    const email = String(new FormData(e.currentTarget).get("email"));
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setPending(false);
    // The server answers the same whether or not the address has an account; only transport errors are shown.
    if (error && error.status !== 400) return setErr("We couldn't send the email right now. Please try again.");
    setSent(true);
  }

  return (
    <AuthLayout title="Reset your password" sub="Enter your email and we'll send you a link to choose a new one."
      footer={<Link className="font-semibold text-p-700 hover:underline" href="/login">Back to log in</Link>}>
      {sent ? (
        <div className="space-y-4">
          <Alert tone="good">If an account exists for that email, a reset link is on its way. It expires in 1 hour.</Alert>
          <p className="text-sm text-muted">Nothing arrived? Check your spam folder, or <button className="font-semibold text-p-700 hover:underline" onClick={() => setSent(false)}>try another address</button>.</p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-sm font-medium">Work email<input name="email" type="email" required autoFocus autoComplete="username" className="field font-normal" placeholder="you@company.com" /></label>
          {err && <Alert>{err}</Alert>}
          <SubmitButton pending={pending}>{pending ? "Sending" : "Send reset link"}</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}
