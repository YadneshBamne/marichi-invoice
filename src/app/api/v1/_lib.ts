import { db } from "@/server/db/client";
import { authenticateKey, bearer } from "@/server/erp/keys";
import { ApiError } from "@/server/erp/invoices";

export const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
export const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) => reply({ error: { code, message, ...extra } }, status);
export const fromError = (e: unknown) => (e instanceof ApiError ? fail(e.status, e.code, e.message, e.extra) : fail(500, "SERVER_ERROR", "something went wrong on our side"));

// Per-key request limit. In memory, so it is per server instance: a safety net against a runaway script, not a security control.
const hits = new Map<string, { n: number; reset: number }>();
const LIMIT = 120; // requests per minute per key

/** Authenticate a request by its API key. Returns the caller, or the error response to send. */
export async function authed(req: Request) {
  const who = await authenticateKey(db, bearer(req));
  if (!who) return { res: fail(401, "UNAUTHORIZED", "send your API key as: Authorization: Bearer <key>") } as const;
  const now = Date.now(), h = hits.get(who.keyId);
  if (!h || now > h.reset) hits.set(who.keyId, { n: 1, reset: now + 60_000 });
  else if (++h.n > LIMIT) return { res: fail(429, "RATE_LIMITED", `limit is ${LIMIT} requests a minute`, { retryAfterSeconds: Math.ceil((h.reset - now) / 1000) }) } as const;
  return { who } as const;
}
