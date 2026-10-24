import Link from "next/link";
import { db } from "@/server/db/client";
import { getSession } from "@/server/session";
import { previewInvitation } from "@/server/company/invitations";
import { ORG_ROLE_BLURB, ORG_ROLE_LABEL } from "@/server/permissions";
import { AuthLayout } from "@/components/ui/public";
import { Alert } from "@/components/ui/forms";
import { JoinExisting, JoinNew } from "./form";

export const metadata = { title: "Join your company" };

const WHY: Record<string, string> = {
  expired: "This invitation has expired. Ask the person who invited you to send a new one.",
  used: "This invitation has already been used. If that was you, just sign in.",
  cancelled: "This invitation was cancelled. Ask the person who invited you to send a new one.",
};

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await previewInvitation(db, token);
  if (!p) return <AuthLayout title="Invitation not found" sub="The link may be incomplete."><Alert>We do not recognise this invitation link. Open it again from the email, or ask for a new one.</Alert></AuthLayout>;
  if (p.state !== "open") return <AuthLayout title="This invitation is closed"><Alert>{WHY[p.state]}</Alert><p className="mt-4 text-sm"><Link className="font-semibold text-p-700 underline" href="/login">Go to sign in</Link></p></AuthLayout>;

  const s = await getSession();
  const signedIn = s?.user.email.toLowerCase() === p.email;
  return (
    <AuthLayout title={`Join ${p.company}`} sub={`You were invited as ${ORG_ROLE_LABEL[p.orgRole]}. ${ORG_ROLE_BLURB[p.orgRole]}`}>
      {signedIn ? <JoinExisting token={token} company={p.company} />
        : s ? <Alert>You are signed in as {s.user.email}, but this invitation is for {p.email}. Sign out first, then open the link again.</Alert>
        : p.hasAccount ? (
          <div className="space-y-4">
            <p className="text-sm text-muted">{p.email} already has a Marichi account. Sign in to add {p.company} to it.</p>
            <Link className="btn btn-primary w-full" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to join</Link>
          </div>
        ) : <JoinNew token={token} email={p.email} />}
    </AuthLayout>
  );
}
