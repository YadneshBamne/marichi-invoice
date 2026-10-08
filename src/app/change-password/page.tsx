"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "@/components/ui/public";
import { Alert, PasswordInput, SubmitButton } from "@/components/ui/forms";
import { clearMustChangePassword } from "./actions";

export default function ChangePassword() {
  const router = useRouter();
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr("");
    const f = new FormData(e.currentTarget);
    if (f.get("next") !== f.get("confirm")) return setErr("The two new passwords don't match.");
    if (f.get("next") === f.get("current")) return setErr("Choose a password different from the temporary one.");
    setPending(true);
    const { error } = await authClient.changePassword({ currentPassword: String(f.get("current")), newPassword: String(f.get("next")), revokeOtherSessions: true });
    if (error) { setPending(false); return setErr(error.message ?? "Could not change the password. Check the temporary password."); }
    await clearMustChangePassword();
    router.push("/dashboard"); // the guard continues the journey: two-factor setup next, then the workspace
    router.refresh();
  }

  return (
    <AuthLayout title="Choose your own password" sub="Your company owner gave you a temporary password. Replace it before you continue.">
      <form onSubmit={onSubmit} className="space-y-4">
        <PasswordInput label="Temporary password" name="current" required autoComplete="current-password" autoFocus />
        <PasswordInput label="New password" name="next" required minLength={10} autoComplete="new-password" />
        <PasswordInput label="Confirm new password" name="confirm" required minLength={10} autoComplete="new-password" />
        <p className="text-xs text-muted">At least 10 characters. Only you will know it.</p>
        {err && <Alert>{err}</Alert>}
        <SubmitButton pending={pending}>{pending ? "Saving" : "Save and continue"}</SubmitButton>
      </form>
    </AuthLayout>
  );
}
