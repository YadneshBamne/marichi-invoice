"use client";
import { useState } from "react";
import { quoteEarly } from "@/server/earlypay/quote";
import { formatINR } from "@/lib/money";

/** Live preview of an early-payment proposal. The maths is the same function the server uses to price it. */
export function QuoteForm({ amount, days, minBps, maxBps, feeBps, action, invoiceId }: {
  amount: string; days: number; minBps: number; maxBps: number; feeBps: number; action: (fd: FormData) => void | Promise<void>; invoiceId: string;
}) {
  const [pct, setPct] = useState(12);
  const [treasury, setTreasury] = useState(7);
  const bps = Math.round(pct * 100);
  const ok = bps >= minBps && bps <= maxBps;
  const q = ok ? quoteEarly(BigInt(amount), days, bps, feeBps) : null;
  // What the buyer earns on the cash it pays today, annualised.
  const buyerApr = q && q.net > 0n ? Number((q.discount * 10_000n * 365n) / (q.net * BigInt(days))) / 100 : 0;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <label className="block text-xs font-medium">Discount you ask for (% a year, {minBps / 100} to {maxBps / 100})
        <input name="discountPct" type="number" step="0.01" min={minBps / 100} max={maxBps / 100} value={pct} onChange={(e) => setPct(Number(e.target.value))} required className="field !py-2 text-sm font-normal" /></label>
      <label className="block text-xs font-medium">Your treasury rate (% a year, for comparison only)
        <input type="number" step="0.01" value={treasury} onChange={(e) => setTreasury(Number(e.target.value))} className="field !py-2 text-sm font-normal" /></label>
      {q ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg bg-panel p-3 text-xs">
          <dt className="text-muted">You pay today</dt><dd className="text-right font-semibold">{formatINR(q.net)}</dd>
          <dt className="text-muted">You save</dt><dd className="text-right">{formatINR(q.discount)}</dd>
          <dt className="text-muted">Your annualised return</dt><dd className="text-right">{buyerApr.toFixed(2)}%</dd>
          <dt className="text-muted">Against treasury rate</dt><dd className={`text-right font-semibold ${buyerApr >= treasury ? "text-g-600" : "text-r-600"}`}>{buyerApr >= treasury ? "+" : ""}{(buyerApr - treasury).toFixed(2)} points</dd>
          <dt className="text-muted">Supplier&apos;s all-in cost</dt><dd className="text-right">{(q.sellerCostBps / 100).toFixed(2)}% a year</dd>
        </dl>
      ) : <p className="text-xs text-r-600">Enter a rate between {minBps / 100}% and {maxBps / 100}%.</p>}
      <button className="btn btn-primary btn-sm w-full" disabled={!ok}>Send to supplier</button>
    </form>
  );
}
