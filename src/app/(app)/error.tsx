"use client";
import Link from "next/link";
import { useEffect } from "react";
import { Icon } from "@/components/ui/icons";

// This Next version passes `retry` (not `reset`) to error boundaries.
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="mx-auto max-w-xl py-10 text-center">
      <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-r-100 text-r-600"><Icon name="alert" className="h-8 w-8" /></span>
      <p className="mt-6 text-xs font-semibold tracking-[.14em] text-faint uppercase">Something went wrong</p>
      <h1 className="page-title mt-2">We couldn&apos;t load this page</h1>
      <p className="page-sub mx-auto max-w-md">The problem is on our side and your data is safe. Try again, and if it keeps happening, contact support and quote the reference below.</p>
      {error.digest && <p className="mt-4 inline-block rounded-lg bg-panel px-3 py-1.5 font-mono text-xs text-muted">Reference: {error.digest}</p>}
      <div className="mt-6 flex justify-center gap-3">
        <button onClick={() => retry()} className="btn btn-primary"><Icon name="refresh" className="h-4 w-4" />Try again</button>
        <Link href="/dashboard" className="btn btn-ghost">Go to dashboard</Link>
      </div>
    </div>
  );
}
