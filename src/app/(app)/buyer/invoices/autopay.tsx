"use client";
import { useActionState } from "react";
import { Alert, Spinner } from "@/components/ui/forms";
import { Panel, StatusPill } from "@/components/ui/page";
import { authoriseAutopay, revokeAutopay, setupAutopay, type AutopayState } from "./autopay-actions";
import { market } from "@/lib/countries";

export type MandateView = { id: string; status: string; maskedAccount: string; ifsc: string; maxLabel: string; authUrl?: string | null } | null;

/** Auto-pay: let Marichi debit the company's bank account on the day a financed invoice falls due. */
export function Autopay({ mandate, canManage, mock }: { mandate: MandateView; canManage: boolean; mock: boolean }) {
  const [state, action, pending] = useActionState<AutopayState, FormData>(setupAutopay, {});
  const open = mandate && ["pending", "active"].includes(mandate.status);
  const v = state.values ?? {};

  return (
    <Panel title="Auto-pay" sub="Never miss a due date: we debit your account on the day, with a notice the day before." action={mandate && <StatusPill status={mandate.status === "active" ? "approved" : mandate.status === "pending" ? "pending" : "rejected"} label={mandate.status === "active" ? "On" : mandate.status} />}>
      {open ? (
        <div className="space-y-4 text-sm">
          <p>Account <b className="font-mono">{mandate.maskedAccount}</b> ({mandate.ifsc}). Each debit is limited to <b>{mandate.maxLabel}</b>.</p>
          {mandate.status === "pending" && <p className="text-muted">Waiting for your bank to authorise the mandate.</p>}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {mandate.status === "pending" && mandate.authUrl && <a className="btn btn-primary btn-sm" href={mandate.authUrl} target="_blank" rel="noreferrer">Authorise at your bank</a>}
              {mandate.status === "pending" && mock && <form action={authoriseAutopay}><button className="btn btn-primary btn-sm">Authorise (simulated bank page)</button></form>}
              <form action={revokeAutopay}><input type="hidden" name="mandateId" value={mandate.id} /><button className="btn btn-ghost btn-sm">Turn auto-pay off</button></form>
            </div>
          )}
        </div>
      ) : !canManage ? (
        <p className="text-sm text-muted">Auto-pay is not set up. An approver or the owner can turn it on.</p>
      ) : (
        <form key={JSON.stringify(v)} action={action} className="grid gap-4 text-sm sm:grid-cols-2">
          {mandate && <p className="text-muted sm:col-span-2">Your last auto-pay mandate was {mandate.status}. You can set it up again.</p>}
          <label className="block font-medium">Bank account number<input name="accountNumber" required inputMode="numeric" defaultValue={v.accountNumber} className="field font-normal" /></label>
          <label className="block font-medium">{market().ids.bankCode.label}<input name="ifsc" required defaultValue={v.ifsc} className="field font-normal" /></label>
          <label className="block font-medium">Account holder name<input name="holderName" required defaultValue={v.holderName} className="field font-normal" /></label>
          <label className="block font-medium">Limit for a single debit ({market().currency.symbol})<input name="maxAmount" required inputMode="decimal" defaultValue={v.maxAmount} placeholder="e.g. 10,00,000" className="field font-normal" /></label>
          {state.error && <div className="sm:col-span-2"><Alert>{state.error}</Alert></div>}
          <div className="sm:col-span-2"><button disabled={pending} className="btn btn-primary">{pending && <Spinner />}Turn on auto-pay</button>
            <span className="ml-3 text-xs text-muted">Your bank will ask you to authorise it. You can turn it off any time.</span></div>
        </form>
      )}
    </Panel>
  );
}
