// Gateway hardening (PRD 12.1): timeout, retry with backoff, per-provider circuit breaker, response cache, call log + metrics.
// Wraps every method of every port, so no module changes. Errors still propagate: KYC/AML stay fail-closed.
import type { Adapters } from "./gateway";

export class CircuitOpenError extends Error {
  constructor(port: string) { super(`${port} provider circuit is open; failing fast`); }
}

export type Opts = {
  timeoutMs: number; retries: number; backoffMs: number; breakAfter: number; coolOffMs: number; cacheTtlMs: number;
  timeouts: Record<string, number>; // "port.method": a longer allowance than timeoutMs for slow calls
  noRetry: string[]; // "port.method": not safe to repeat, or the caller already has a retry queue
  cache: string[];   // "port.method": pure lookups whose answer is stable for cacheTtlMs
  now: () => number; sleep: (ms: number) => Promise<void>; log: (line: string) => void;
};
export const DEFAULTS: Opts = {
  timeoutMs: 10_000, retries: 2, backoffMs: 200, breakAfter: 5, coolOffMs: 30_000, cacheTtlMs: 24 * 3_600_000,
  timeouts: { "ocr.extractInvoice": 90_000 }, // reading a document takes a while
  noRetry: ["notify.send", "ocr.extractInvoice"], // a repeat costs money; the user can simply press the button again
  // (notify.send is retried by the outbox itself) // the notification outbox retries with its own schedule; a blind repeat could double-send an SMS
  cache: ["kyc.verifyPan", "bureau.pull"],
  now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (l) => console.log(l),
};

export type Stat = { calls: number; errors: number; totalMs: number; maxMs: number; circuit: "closed" | "open"; lastError?: string };
const stats = new Map<string, Stat>();
/** Per-process counters (web and worker each have their own). Keyed by port. */
export const gatewayStats = () => Object.fromEntries(stats);
export const resetGatewayStats = () => stats.clear();

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });

export function harden(base: Adapters, o: Partial<Opts> = {}): Adapters {
  const c = { ...DEFAULTS, ...o };
  const cache = new Map<string, { at: number; v: unknown }>();
  const out: Record<string, Record<string, unknown>> = {};

  for (const [port, impl] of Object.entries(base) as unknown as [string, Record<string, (...a: unknown[]) => Promise<unknown>>][]) {
    const s: Stat = { calls: 0, errors: 0, totalMs: 0, maxMs: 0, circuit: "closed" };
    stats.set(port, s);
    let fails = 0, openedAt = 0;
    out[port] = {};
    for (const [method, fn] of Object.entries(impl)) {
      const name = `${port}.${method}`;
      out[port][method] = async (...args: unknown[]) => {
        const key = c.cache.includes(name) ? `${name}:${JSON.stringify(args, (_, v) => (typeof v === "bigint" ? `${v}n` : v))}` : null;
        const hit = key && cache.get(key);
        if (hit && c.now() - hit.at < c.cacheTtlMs) return hit.v;

        // Open circuit: fail fast until the cool-off ends, then let one trial call through (half-open).
        if (fails >= c.breakAfter && c.now() - openedAt < c.coolOffMs) throw new CircuitOpenError(port);

        const tries = c.noRetry.includes(name) ? 1 : 1 + c.retries;
        let last: unknown;
        for (let i = 0; i < tries; i++) {
          const t0 = c.now();
          s.calls++;
          try {
            const v = await withTimeout(fn.apply(impl, args), c.timeouts[name] ?? c.timeoutMs, name);
            const ms = c.now() - t0; s.totalMs += ms; s.maxMs = Math.max(s.maxMs, ms);
            fails = 0; s.circuit = "closed";
            c.log(`[gateway] ${name} ok ${ms}ms${i ? ` (attempt ${i + 1})` : ""}`);
            if (key) cache.set(key, { at: c.now(), v });
            return v;
          } catch (e) {
            last = e; s.errors++; s.lastError = e instanceof Error ? e.message : String(e);
            fails++; // a failed half-open trial re-opens immediately because fails stays >= breakAfter
            c.log(`[gateway] ${name} failed attempt ${i + 1}/${tries}: ${s.lastError}`);
            if (fails >= c.breakAfter) { openedAt = c.now(); s.circuit = "open"; break; }
            if (i < tries - 1) await c.sleep(c.backoffMs * 2 ** i);
          }
        }
        throw last;
      };
    }
  }
  return out as unknown as Adapters;
}
