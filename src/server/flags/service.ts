// Feature flags: switch a capability off for everyone, or roll it out to a share of companies, or to chosen companies first, without
// changing code. A flag with no row is ON, so a new flag never switches anything off by being added. Checks are synchronous and read a
// copy of the table that each web request and each worker job refreshes (at most every 30 seconds), exactly like policy settings.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, featureFlags } from "../db/schema";

export const FLAGS = [
  { key: "signup", label: "New sign-ups", help: "Off pauses account creation. People who already have accounts are not affected." },
  { key: "api", label: "API access for companies", help: "Off makes every API key answer that the API is switched off." },
  { key: "autobid", label: "Standing bids from financiers", help: "Off stops automatic bidding; manual bids still work." },
  { key: "earlypay", label: "Buyer early payment", help: "Dynamic discounting: a buyer offering to pay a supplier early." },
  { key: "scf", label: "Supplier finance programmes", help: "Buyer-led programmes and their supplier invitations." },
  { key: "export", label: "Export financing", help: "Invoices on overseas buyers." },
] as const;
export type FlagKey = (typeof FLAGS)[number]["key"];

type Row = typeof featureFlags.$inferSelect;
let cache = new Map<string, Row>();
let loadedAt = 0;

/** Bring this process up to date. Cheap: one query at most every 30 seconds. */
export async function refreshFlags(db: Database, force = false, now = Date.now()) {
  if (!force && now - loadedAt < 30_000) return;
  loadedAt = now;
  cache = new Map((await db.select().from(featureFlags)).map((r) => [r.key, r]));
}
/** Tests only. */
export const resetFlagsForTests = () => { cache = new Map(); loadedAt = 0; };

const bucket = (key: string, businessId: string) => parseInt(createHash("sha256").update(`${key}:${businessId}`).digest("hex").slice(0, 8), 16) % 100;

/** Is this on, for this company? With no company (sign-up, anonymous), only the on/off switch counts. */
export function flagOn(key: FlagKey, businessId?: string | null): boolean {
  const r = cache.get(key);
  if (!r) return true;
  if (!r.enabled) return false;
  if (!businessId) return true;
  if (r.onlyBusinesses.length > 0 && r.onlyBusinesses.includes(businessId)) return true; // chosen companies always get it
  return bucket(key, businessId) < r.rolloutPct;
}

export function assertFlag(key: FlagKey, businessId?: string | null) {
  if (!flagOn(key, businessId)) throw new Error(`${FLAGS.find((f) => f.key === key)?.label ?? key} is switched off for your company right now`);
}

export async function listFlags(db: Database) {
  const rows = new Map((await db.select().from(featureFlags)).map((r) => [r.key, r]));
  const ids = [...rows.values()].flatMap((r) => r.onlyBusinesses);
  const names = ids.length ? new Map((await db.select({ id: businesses.id, n: businesses.legalName }).from(businesses)).filter((b) => ids.includes(b.id)).map((b) => [b.id, b.n])) : new Map<string, string>();
  return FLAGS.map((f) => { const r = rows.get(f.key); return { ...f, enabled: r?.enabled ?? true, rolloutPct: r?.rolloutPct ?? 100, onlyBusinesses: (r?.onlyBusinesses ?? []).map((id) => ({ id, name: names.get(id) ?? id })), note: r?.note ?? null, updatedAt: r?.updatedAt ?? null }; });
}

/** Change a flag. `early` are company numbers (GSTIN, TPIN) of companies that always get it. Every change needs a reason and is audited. */
export async function setFlag(db: Database, actor: { id: string; role: string }, p: { key: string; enabled: boolean; rolloutPct: number; early?: string[]; note: string }) {
  if (actor.role !== "admin") throw new Error("only an administrator can change feature flags");
  if (!FLAGS.some((f) => f.key === p.key)) throw new Error("unknown flag");
  if (!Number.isInteger(p.rolloutPct) || p.rolloutPct < 0 || p.rolloutPct > 100) throw new Error("the rollout is a whole number from 0 to 100");
  if (p.note.trim().length < 5) throw new Error("explain the reason for the change (at least 5 characters)");
  const wanted = [...new Set((p.early ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  let ids: string[] = [];
  if (wanted.length) {
    const found = await db.select({ id: businesses.id, g: businesses.gstin }).from(businesses);
    const byNumber = new Map(found.filter((b) => b.g).map((b) => [b.g!.toUpperCase(), b.id]));
    const missing = wanted.filter((w) => !byNumber.has(w));
    if (missing.length) throw new Error(`no company with the number ${missing.join(", ")}`);
    ids = wanted.map((w) => byNumber.get(w)!);
  }
  const [prev] = await db.select().from(featureFlags).where(eq(featureFlags.key, p.key));
  const next = { key: p.key, enabled: p.enabled, rolloutPct: p.rolloutPct, onlyBusinesses: ids, note: p.note.trim(), updatedBy: actor.id, updatedAt: new Date() };
  await db.insert(featureFlags).values(next).onConflictDoUpdate({ target: featureFlags.key, set: next });
  await db.insert(auditLog).values({ actorId: actor.id, action: "flag.changed", entity: "flag", entityId: p.key, before: prev ? { enabled: prev.enabled, rolloutPct: prev.rolloutPct, early: prev.onlyBusinesses.length } : { enabled: true, rolloutPct: 100, early: 0 }, after: { enabled: p.enabled, rolloutPct: p.rolloutPct, early: ids.length, note: p.note.trim() } });
  await refreshFlags(db, true);
}
