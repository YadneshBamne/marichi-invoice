"use client";
import { useRef, useState, useTransition } from "react";
import { Alert, Spinner } from "@/components/ui/forms";
import { Icon } from "@/components/ui/icons";
import { Card } from "@/components/ui/cards";
import { INVITABLE, ORG_ROLE_BLURB, ORG_ROLE_LABEL, POWERFUL, type OrgRole } from "@/server/permissions";
import { acceptOwner, cancelInvite, cancelOwnerOffer, changeRole, invite, offerOwner, resend, sendResetLink, setDual, suspend } from "./actions";

export type Person = { id: string; name: string; email: string; orgRole: OrgRole; suspended: boolean; twoFactor: boolean; you: boolean };
export type Invite = { id: string; email: string; orgRole: OrgRole; expired: boolean; expiresAt: string };
type Transfer = { toId: string; toName: string; expiresAt: string } | null;

const ROLE_PILL: Record<OrgRole, string> = { owner: "bg-p-700 text-white", admin: "bg-i-100 text-i-500", approver: "bg-p-100 text-p-700", maker: "bg-panel text-muted", viewer: "bg-panel text-faint" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function TeamManager({ people, invites, me, manage, grant, dual, transfer }: {
  people: Person[]; invites: Invite[]; me: { id: string; orgRole: string }; manage: boolean; grant: boolean; dual: boolean; transfer: Transfer;
}) {
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const owner = me.orgRole === "owner";
  // The roles this person may hand out: only the owner gives approver or admin, because those carry money power.
  const grantable = INVITABLE.filter((r) => grant || !POWERFUL.includes(r));

  const run = (id: string, fn: () => Promise<{ ok: boolean; error?: string; emailed?: boolean }>, done?: string) => {
    setErr(""); setNote(""); setBusy(id);
    start(async () => {
      const r = await fn();
      setBusy(null);
      if (!r.ok) { setErr(r.error ?? "Something went wrong."); return; }
      if (r.emailed === false) setNote("The invitation was saved but the email could not be sent. Use Resend to try again.");
      else if (done) setNote(done);
    });
  };
  const canTouch = (p: Person) => manage && p.orgRole !== "owner" && !p.you && (grant || !POWERFUL.includes(p.orgRole));

  return (
    <div className="space-y-5">
      {err && <Alert>{err}</Alert>}
      {note && <Alert tone="good">{note}</Alert>}

      {transfer && transfer.toId === me.id && (
        <div className="rounded-card bg-p-100 p-5 ring-1 ring-p-400">
          <p className="font-semibold">You have been offered ownership of this company</p>
          <p className="mt-1 text-sm text-muted">Accepting makes you the only owner. The current owner becomes an admin. The offer stands until {day(transfer.expiresAt)}.</p>
          <button className="btn btn-primary mt-3" disabled={pending} onClick={() => run("acc", acceptOwner, "You are now the owner.")}>{busy === "acc" && <Spinner />}Accept ownership</button>
        </div>
      )}

      <Card title={`People (${people.length})`}>
        <ul className="divide-y divide-hair">
          {people.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-3.5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-s-100 text-[13px] font-bold text-s-600">{p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-semibold">{p.name}{p.you && <span className="text-xs font-normal text-faint">(you)</span>}
                  <span className={`pill ${ROLE_PILL[p.orgRole]}`}>{ORG_ROLE_LABEL[p.orgRole]}</span>
                  {p.suspended && <span className="pill bg-r-100 text-r-600">Suspended</span>}
                  {!p.twoFactor && !p.suspended && <span className="pill bg-s-100 text-s-600">Two-step not set up</span>}
                </span>
                <span className="block truncate text-[13px] text-muted">{p.email}</span>
              </span>
              {canTouch(p) && (
                <span className="flex flex-wrap items-center gap-2">
                  <select aria-label={`Role for ${p.name}`} value={p.orgRole} disabled={pending} className="field-inline !py-1.5 text-sm"
                    onChange={(e) => run(p.id, () => changeRole(p.id, e.target.value), "Role updated.")}>
                    {INVITABLE.filter((r) => grant || !POWERFUL.includes(r) || r === p.orgRole).map((r) => <option key={r} value={r}>{ORG_ROLE_LABEL[r]}</option>)}
                  </select>
                  <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(p.id, () => sendResetLink(p.id), `A password reset link was sent to ${p.email}.`)}>{busy === p.id && <Spinner />}Send reset link</button>
                  <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(p.id, () => suspend(p.id, !p.suspended))}>{p.suspended ? "Reactivate" : "Suspend"}</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {manage && invites.length > 0 && (
        <Card title={`Waiting to join (${invites.length})`}>
          <ul className="divide-y divide-hair">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">{i.email}<span className={`pill ${ROLE_PILL[i.orgRole]}`}>{ORG_ROLE_LABEL[i.orgRole]}</span>
                    {i.expired ? <span className="pill bg-r-100 text-r-600">Expired</span> : <span className="text-xs font-normal text-faint">link works until {day(i.expiresAt)}</span>}</span>
                </span>
                {(grant || !POWERFUL.includes(i.orgRole)) && (
                  <span className="flex gap-2">
                    <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(i.id, () => resend(i.id), "A fresh link was sent.")}>{busy === i.id && <Spinner />}Resend</button>
                    <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(i.id, () => cancelInvite(i.id), "Invitation cancelled.")}>Cancel</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {manage ? (
        <Card title="Invite someone">
          <form ref={form} className="grid gap-4" onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            run("invite", async () => { const r = await invite({ email: String(fd.get("email")), orgRole: String(fd.get("orgRole")) }); if (r.ok) form.current?.reset(); return r; }, "Invitation sent. They choose their own password.");
          }}>
            <label className="block text-sm font-medium">Work email<input name="email" type="email" required className="field font-normal" placeholder="name@company.com" /></label>
            <fieldset>
              <legend className="text-sm font-medium">Role</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {grantable.map((r) => (
                  <label key={r} className="flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-hair transition-all has-[:checked]:bg-p-100 has-[:checked]:ring-2 has-[:checked]:ring-p-700">
                    <input type="radio" name="orgRole" value={r} defaultChecked={r === "maker"} className="mt-1" />
                    <span className="text-sm"><b>{ORG_ROLE_LABEL[r]}</b><span className="mt-0.5 block text-xs text-muted">{ORG_ROLE_BLURB[r]}</span></span>
                  </label>
                ))}
              </div>
              {!grant && <p className="mt-2 text-xs text-muted">Only the owner can invite an approver or an admin, because they carry money and access power.</p>}
            </fieldset>
            <div><button disabled={pending} className="btn btn-primary">{busy === "invite" ? <Spinner /> : <Icon name="email" className="h-4 w-4" />}Send invitation</button>
              <span className="ml-3 text-xs text-muted">They get an emailed link, set their own password and two-step verification. The link works once for 10 days.</span></div>
          </form>
        </Card>
      ) : <p className="text-sm text-muted">Only an owner or admin can invite or change people.</p>}

      {owner && (
        <Card title="Approvals and ownership">
          <div className="space-y-5 text-sm">
            <label className="flex items-start gap-3">
              <input type="checkbox" checked={dual} disabled={pending} onChange={(e) => run("dual", () => setDual(e.target.checked), e.target.checked ? "Dual control is on." : "Dual control is off.")} className="mt-1" />
              <span><b>Require a second approver for everything</b><span className="mt-0.5 block text-xs text-muted">Off: approvers and the owner commit on their own, and makers send requests for approval. On: every commitment, even yours, waits for a different approver. Large amounts always need a second person either way.</span></span>
            </label>
            <div className="border-t border-hair pt-4">
              <p className="font-semibold">Transfer ownership</p>
              {transfer && transfer.toId !== me.id ? (
                <p className="mt-1 text-muted">Offered to <b>{transfer.toName}</b>; it stands until {day(transfer.expiresAt)}. <button className="font-semibold text-p-700 underline" disabled={pending} onClick={() => run("co", cancelOwnerOffer, "Offer withdrawn.")}>Withdraw</button></p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted">Offer the company to an admin or approver. Nothing changes until they accept, and then you become an admin.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {people.filter((p) => !p.you && !p.suspended && POWERFUL.includes(p.orgRole)).map((p) => (
                      <button key={p.id} className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run("o" + p.id, () => offerOwner(p.id), `Offer sent to ${p.name}.`)}>Offer to {p.name}</button>
                    ))}
                    {!people.some((p) => !p.you && !p.suspended && POWERFUL.includes(p.orgRole)) && <span className="text-xs text-faint">Invite an admin or approver first.</span>}
                  </div>
                </>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
