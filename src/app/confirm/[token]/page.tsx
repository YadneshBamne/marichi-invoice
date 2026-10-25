import { db } from "@/server/db/client";
import { viewByToken } from "@/server/confirmations/link";
import { AuthLayout } from "@/components/ui/public";
import { Alert } from "@/components/ui/forms";
import { ConfirmFlow } from "./form";

export const metadata = { title: "Confirm an invoice", robots: { index: false, follow: false } };

export default async function Confirm({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = await viewByToken(db, token);
  if (v.state !== "open") {
    if (v.state === "unknown") return <AuthLayout title="Link not found" sub="It may be incomplete."><Alert>We do not recognise this link. Open it again from the email.</Alert></AuthLayout>;
    if (v.state === "answered") return <AuthLayout title={`Invoice ${v.invoiceNumber}`} sub="This invoice has already been answered."><Alert tone="good">{v.outcome === "confirmed" ? "It was confirmed." : "It was disputed."} Nothing more is needed.</Alert></AuthLayout>;
    if (v.state === "closed") return <AuthLayout title={`Invoice ${v.invoiceNumber}`}><Alert>This invoice is no longer waiting for confirmation.</Alert></AuthLayout>;
    return <AuthLayout title={`Invoice ${v.invoiceNumber}`}><Alert>This link has expired. Ask your supplier to resend the invoice.</Alert></AuthLayout>;
  }
  return (
    <AuthLayout title="Please confirm this invoice" sub="Your supplier has asked you to confirm it. Confirming, disputing or asking a question takes a minute and needs no account." wide>
      <ConfirmFlow token={token} v={{ invoice: v.invoice, wording: v.wording, dispute: v.dispute, clarify: v.clarify }} />
    </AuthLayout>
  );
}
