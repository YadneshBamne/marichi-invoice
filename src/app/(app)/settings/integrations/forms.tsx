"use client";
import { useActionState, useState } from "react";
import { Alert, Spinner } from "@/components/ui/forms";
import { EVENT_TYPES } from "@/server/erp/events";
import { newEndpoint, newKey, type Secret } from "./actions";

/** A secret that is shown exactly once. */
function Reveal({ s }: { s: NonNullable<Secret["secret"]> }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="anim-pop rounded-xl bg-p-100 p-4 ring-1 ring-p-400">
      <p className="text-sm font-semibold">Your {s.label.toLowerCase()}. Copy it now: it will not be shown again.</p>
      <p className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-card px-3 py-2 font-mono text-[13px] shadow-card">
        <span className="break-all">{s.value}</span>
        <button type="button" className="ml-auto font-sans text-sm font-semibold text-p-700 hover:underline" onClick={() => { navigator.clipboard?.writeText(s.value); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
      </p>
    </div>
  );
}

export function NewKeyForm() {
  const [state, action, pending] = useActionState<Secret, FormData>(newKey, {});
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="block min-w-56 flex-1 text-sm font-medium">Name<input name="name" required minLength={2} placeholder="e.g. Tally sync" className="field font-normal" /></label>
        <button disabled={pending} className="btn btn-primary">{pending && <Spinner />}Create key</button>
      </form>
      {state.error && <Alert>{state.error}</Alert>}
      {state.secret && <Reveal s={state.secret} />}
    </div>
  );
}

export function NewEndpointForm() {
  const [state, action, pending] = useActionState<Secret, FormData>(newEndpoint, {});
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-3">
        <label className="block text-sm font-medium">Address that will receive events<input name="url" required placeholder="https://erp.yourcompany.com/marichi-webhook" className="field font-normal" /></label>
        <fieldset>
          <legend className="text-sm font-medium">Events <span className="font-normal text-muted">(none ticked means all)</span></legend>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">{EVENT_TYPES.filter((e) => e !== "ping").map((e) => <label key={e} className="flex items-center gap-2"><input type="checkbox" name="events" value={e} />{e}</label>)}</div>
        </fieldset>
        <button disabled={pending} className="btn btn-primary">{pending && <Spinner />}Add endpoint</button>
      </form>
      {state.error && <Alert>{state.error}</Alert>}
      {state.secret && <Reveal s={state.secret} />}
    </div>
  );
}
