"use client";
import { useState, type ComponentProps, type ReactNode } from "react";
import { Icon } from "./icons";

/** Password input with a show/hide toggle. Pass any <input> props (name, autoComplete, onChange...). */
export function PasswordInput({ label, hint, ...p }: { label: string; hint?: ReactNode } & Omit<ComponentProps<"input">, "type">) {
  const [show, setShow] = useState(false);
  return (
    <label className="block text-sm font-medium">
      <span className="flex items-center justify-between">{label}{hint}</span>
      <span className="relative mt-1 block">
        <input {...p} type={show ? "text" : "password"} className="field mt-0 pr-11 font-normal" />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} className="absolute inset-y-0 right-0 grid w-11 place-items-center text-faint transition-colors hover:text-ink">
          <Icon name={show ? "eye-off" : "eye"} className="h-[18px] w-[18px]" />
        </button>
      </span>
    </label>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}

export function SubmitButton({ pending, children, className = "" }: { pending?: boolean; children: ReactNode; className?: string }) {
  return <button disabled={pending} className={`btn btn-primary w-full ${className}`}>{pending && <Spinner />}{children}</button>;
}

export function Alert({ tone = "bad", children }: { tone?: "bad" | "good" | "info"; children: ReactNode }) {
  const c = { bad: "bg-r-100 text-r-600", good: "bg-g-100 text-g-600", info: "bg-i-100 text-i-500" }[tone];
  return <p role={tone === "bad" ? "alert" : "status"} className={`anim-pop flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-sm ${c}`}><Icon name={tone === "good" ? "check" : tone === "info" ? "info" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" /><span>{children}</span></p>;
}
