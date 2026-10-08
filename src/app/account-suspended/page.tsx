"use client";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "@/components/ui/public";
import { Alert } from "@/components/ui/forms";

export default function Suspended() {
  return (
    <AuthLayout title="Account suspended" sub="Your access to this workspace has been paused.">
      <div className="space-y-4">
        <Alert>The owner of your company has suspended this account. Contact them to have access restored.</Alert>
        <button className="btn btn-primary w-full" onClick={async () => { await authClient.signOut(); window.location.href = "/login"; }}>Sign out</button>
      </div>
    </AuthLayout>
  );
}
