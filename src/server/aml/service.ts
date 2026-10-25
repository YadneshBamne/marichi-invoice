// Local sanctions screening: downloads the public lists (aml/lists), keeps them in the database, and answers screenAml from an
// in-memory index. Free, no key, no vendor. Fail closed: if the lists were never loaded or have gone stale, screening THROWS, so
// nothing is approved on an out-of-date or empty list (callers already treat a throw as "block", and re-screening as "skip").
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { sanctionsEntries, sanctionsLoads } from "../db/schema";
import type { KycPort } from "../integrations/gateway";
import { EU_URL, OFAC_ALT_URL, OFAC_SDN_URL, UN_URL, parseEuFsf, parseOfacSdn, parseUnConsolidated, type ListEntry, type ListId } from "./lists";
import { normalizeName } from "./normalize";
import { buildIndex, HIT_THRESHOLD, screenName, type Match, type SanctionIndex } from "./screen";

export const LISTS: ListId[] = ["ofac_sdn", "un", "eu"];
const SOURCES: Record<ListId, { urls: string[]; parse: (texts: string[]) => ListEntry[] }> = {
  ofac_sdn: { urls: [OFAC_SDN_URL, OFAC_ALT_URL], parse: ([sdn, alt]) => parseOfacSdn(sdn, alt) },
  un: { urls: [UN_URL], parse: ([xml]) => parseUnConsolidated(xml) },
  eu: { urls: [EU_URL], parse: ([xml]) => parseEuFsf(xml) },
};

const BATCH = 2000; // rows per insert: 8 columns each, well inside Postgres's 65,535 parameter limit
const CACHE_MS = 10 * 60_000; // how long the in-memory index is reused before reloading from the database
const DAY = 86_400_000;
export const MAX_AGE_DAYS = 7;

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const realFetch: Fetch = (url) => fetch(url, { signal: AbortSignal.timeout(180_000) });

export type RefreshResult = { list: ListId; ok: boolean; entries: number; error?: string };

/**
 * Download every list and replace its stored rows (one transaction per list). A list that fails to download, parses to nothing, or
 * shrinks to under half its previous size keeps its old rows and is reported as failed; the other lists carry on.
 */
export async function refreshSanctionLists(db: Database, opts: { fetch?: Fetch; now?: Date } = {}): Promise<RefreshResult[]> {
  const get = opts.fetch ?? realFetch;
  const now = opts.now ?? new Date();
  const results: RefreshResult[] = [];
  for (const list of LISTS) {
    try {
      const src = SOURCES[list];
      const texts = await Promise.all(src.urls.map(async (u) => {
        const res = await get(u);
        if (!res.ok) throw new Error(`${u} answered ${res.status}`);
        return res.text();
      }));
      const rows = src.parse(texts).map((e) => ({ ...e, norm: normalizeName(e.name) })).filter((e) => e.norm);
      if (!rows.length) throw new Error("the file had no entries");
      const [prev] = await db.select({ n: sanctionsLoads.entries }).from(sanctionsLoads).where(eq(sanctionsLoads.list, list)).orderBy(desc(sanctionsLoads.loadedAt)).limit(1);
      if (prev && rows.length < prev.n / 2) throw new Error(`only ${rows.length} entries against ${prev.n} before; keeping the old list`);
      await db.transaction(async (tx) => {
        await tx.delete(sanctionsEntries).where(eq(sanctionsEntries.list, list));
        for (let i = 0; i < rows.length; i += BATCH) await tx.insert(sanctionsEntries).values(rows.slice(i, i + BATCH).map((r) => ({ ...r, loadedAt: now })));
        await tx.insert(sanctionsLoads).values({ list, sourceUrl: src.urls.join(" + "), sha256: createHash("sha256").update(texts.join("\n")).digest("hex"), entries: rows.length, loadedAt: now });
      });
      results.push({ list, ok: true, entries: rows.length });
    } catch (e) {
      results.push({ list, ok: false, entries: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export type ListStatus = { list: ListId; loadedAt: Date | null; entries: number; stale: boolean };

/** Per list: when it last loaded successfully, how many entries, and whether that is older than `maxAgeDays` (or never). */
export async function sanctionsStatus(db: Database, opts: { maxAgeDays?: number; now?: Date } = {}): Promise<ListStatus[]> {
  const now = opts.now ?? new Date(), max = (opts.maxAgeDays ?? MAX_AGE_DAYS) * DAY;
  const last = await db.selectDistinctOn([sanctionsLoads.list]).from(sanctionsLoads).orderBy(sanctionsLoads.list, desc(sanctionsLoads.loadedAt));
  return LISTS.map((list) => {
    const l = last.find((x) => x.list === list);
    return { list, loadedAt: l?.loadedAt ?? null, entries: l?.entries ?? 0, stale: !l || now.getTime() - l.loadedAt.getTime() > max };
  });
}

type Loaded = { index: SanctionIndex; at: number; loads: { list: string; loadedAt: Date }[] };

/** Index cache plus the fail-closed freshness check. */
function loader(db: Database, maxAgeDays: number, now: () => Date) {
  let cached: Loaded | null = null, pending: Promise<Loaded> | null = null;
  const fresh = async (): Promise<Loaded> => {
    const loads = (await sanctionsStatus(db, { maxAgeDays, now: now() })).filter((s) => s.loadedAt).map((s) => ({ list: s.list as string, loadedAt: s.loadedAt! }));
    const rows = await db.select().from(sanctionsEntries);
    return { index: buildIndex(rows), at: now().getTime(), loads };
  };
  return async (): Promise<SanctionIndex> => {
    if (!cached || now().getTime() - cached.at > CACHE_MS) {
      pending ??= fresh().finally(() => { pending = null; });
      cached = await pending;
    }
    // Checked on every call, so a cached index can never outlive the freshness limit.
    const t = now().getTime();
    if (!cached.loads.length || !cached.index.size) throw new Error("sanctions lists have never been loaded; refusing to screen");
    for (const l of cached.loads) if (t - l.loadedAt.getTime() > maxAgeDays * DAY) throw new Error(`sanctions list "${l.list}" is older than ${maxAgeDays} days; refusing to screen`);
    return cached.index;
  };
}

/** A KycPort.screenAml backed by the stored lists. Throws (fails closed) when the lists are missing or stale. */
export function localAml(db: Database, opts: { maxAgeDays?: number; now?: () => Date } = {}): Pick<KycPort, "screenAml"> {
  const index = loader(db, opts.maxAgeDays ?? MAX_AGE_DAYS, opts.now ?? (() => new Date()));
  return {
    async screenAml(name) {
      const top = screenName(await index(), normalizeName(name), 1)[0];
      const score = top?.score ?? 0;
      return { score, hit: score >= HIT_THRESHOLD };
    },
  };
}

const shared = new WeakMap<Database, ReturnType<typeof loader>>();

/** The listed parties a name resembles, best first, for a compliance reviewer. Same fail-closed rules as screenAml. */
export async function screenDetailed(db: Database, name: string, opts: { limit?: number; maxAgeDays?: number; now?: () => Date } = {}): Promise<Match[]> {
  let load = shared.get(db);
  if (!load) shared.set(db, load = loader(db, opts.maxAgeDays ?? MAX_AGE_DAYS, opts.now ?? (() => new Date())));
  return screenName(await load(), normalizeName(name), opts.limit ?? 10);
}
