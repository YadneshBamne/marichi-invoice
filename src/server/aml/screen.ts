// Matching a name against the sanctions entries. Pure: no database, no clock. The service builds the index from the stored rows.
//
// How a score is made (0-100):
//   1. Both names are normalised (aml/normalize) and split into words, so word order and punctuation do not matter.
//   2. Every query word is paired with at most one entry word (best pairs first). Two words pair up when they are equal, when one
//      is an initial of the other ("A" and "Ayman"), or when they are one typo or one close spelling apart (Jaro-Winkler).
//   3. The score is a Dice coefficient over word weights: 2 x (matched weight) / (query weight + entry weight). A listed name with
//      extra words the query lacks, or the other way round, therefore scores lower.
//   4. Common words carry little weight (a business word like "trading", a name particle like "bin", a very common name like
//      "kumar"), and a fuzzy match that rests only on common words is capped below the hit threshold. A query that is one common word
//      ("Ali", "Trading") can never hit. An exact match of two or more words ("Rajesh Gupta") always does: a reviewer decides if it is the same person.
// The same words in any order (including an exact alias) score 100.

export const HIT_THRESHOLD = 88; // a score at or above this counts as a hit and needs a compliance review
const NO_STRONG_CAP = 75; // best score when no distinctive word matched
const WEAK_ALONE_CAP = 60; // best score for a single common word, even if it matches exactly
const INITIAL_SIM = 0.95;
const TYPO_SIM = 0.93; // one slip in a long word
const SHORT_TYPO_SIM = 0.8; // one slip in a short word (Ramesh / Rajesh are different people): helps a match but cannot anchor it
const MIN_WORD_SIM = 0.88; // below this, two longer words are not treated as the same word

// Business words and name particles: say little about who the party is.
const GENERIC = new Set([
  "trading", "trade", "traders", "enterprises", "enterprise", "group", "international", "intl", "holding", "holdings", "industries", "industry",
  "general", "services", "service", "global", "import", "imports", "export", "exports", "exporters", "importers", "bank", "shipping", "logistics",
  "solutions", "technologies", "technology", "systems", "consultancy", "consultants", "construction", "engineering", "investments", "investment",
  "impex", "overseas", "mining", "energy", "oil", "gas", "foods", "textiles", "agencies", "associates", "partners", "ventures", "projects",
  "india", "zambia", "al", "bin", "bint", "abu", "de", "van", "von", "da", "do",
]);
// Very common personal names in India, Zambia and the Arab world: a match on these alone is not evidence.
const COMMON_NAMES = new Set([
  "rajesh", "ramesh", "suresh", "mahesh", "ravi", "amit", "anil", "sunil", "vijay", "sanjay", "rahul", "priya", "pooja", "mohan", "ram", "shyam", "rahman", "rehman",
  "ali", "khan", "kumar", "kumari", "singh", "sharma", "devi", "lal", "das", "patel", "shah", "gupta", "verma", "yadav", "reddy", "rao", "nair", "iyer",
  "mehta", "jain", "agarwal", "joshi", "mishra", "pandey", "kaur", "begum", "bibi", "ahmad", "ahmed", "hasan", "hassan", "husein", "hussain", "abdul",
  "abdullah", "muhamad", "omar", "umar", "ibrahim", "yusuf", "mary", "john", "peter", "joseph", "banda", "phiri", "mwansa", "zulu", "tembo", "mumba",
  "chanda", "lungu", "mulenga", "sakala", "bwalya", "daka", "ngoma", "mwale", "chileshe", "musonda", "kunda", "zimba", "bota", "mutale",
]);
const weak = (w: string) => GENERIC.has(w) || COMMON_NAMES.has(w);
const weightOf = (w: string) => (GENERIC.has(w) ? 0.3 : COMMON_NAMES.has(w) ? 0.6 : 1);
export const strong = (w: string) => w.length > 1 && !weak(w);

export type SanctionEntry = { list: string; externalId: string; name: string; norm: string; kind: string; isAlias: boolean; program: string | null; country: string | null };
export type Match = { score: number; list: string; externalId: string; kind: string; program: string | null; country: string | null; listedName: string; matchedName: string; viaAlias: boolean };
type Indexed = SanctionEntry & { tokens: string[] };
export type SanctionIndex = { size: number; byKey: Map<string, Indexed[]>; byToken: Map<string, Indexed[]>; byLetter: Map<string, string[]>; primary: Map<string, Indexed> };

const wordsOf = (norm: string) => norm.split(" ").filter(Boolean);
const keyOf = (words: string[]) => [...words].sort().join(" ");

/** Index the stored entries for fast lookup. Build once, reuse for many queries. */
export function buildIndex(entries: SanctionEntry[]): SanctionIndex {
  const idx: SanctionIndex = { size: 0, byKey: new Map(), byToken: new Map(), byLetter: new Map(), primary: new Map() };
  for (const e of entries) {
    const tokens = wordsOf(e.norm);
    if (!tokens.length) continue;
    const row = { ...e, tokens };
    idx.size++;
    const key = keyOf(tokens);
    (idx.byKey.get(key) ?? idx.byKey.set(key, []).get(key)!).push(row);
    for (const t of new Set(tokens)) (idx.byToken.get(t) ?? idx.byToken.set(t, []).get(t)!).push(row);
    if (!e.isAlias) idx.primary.set(`${e.list}:${e.externalId}`, row);
  }
  for (const t of idx.byToken.keys()) (idx.byLetter.get(t[0]) ?? idx.byLetter.set(t[0], []).get(t[0])!).push(t);
  return idx;
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false), bm = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j <= Math.min(b.length - 1, i + range); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

/** True when the words differ by one substitution, one insertion/deletion, or one swap of neighbouring letters. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

/** How alike two words are, 0 to 1. Short words must match exactly or be an initial; one-letter typos only count from 4 letters. */
function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) return (a.length === 1 ? b.startsWith(a) : a.startsWith(b)) ? INITIAL_SIM : 0;
  if (a.length < 4 || b.length < 4) return 0;
  if (withinOneEdit(a, b)) return Math.min(a.length, b.length) >= 7 ? TYPO_SIM : SHORT_TYPO_SIM;
  if (a.length < 5 || b.length < 5) return 0;
  const jw = jaroWinkler(a, b);
  return jw >= MIN_WORD_SIM ? jw : 0;
}

/** Score one entry against the query words (0-100, not yet rounded). */
function score(q: string[], e: string[], sims: Map<string, number>): number {
  const sim = (a: string, b: string) => { const k = `${a}|${b}`; let v = sims.get(k); if (v === undefined) sims.set(k, v = wordSim(a, b)); return v; };
  const pairs: { qi: number; ei: number; s: number }[] = [];
  q.forEach((qw, qi) => e.forEach((ew, ei) => { const s = sim(qw, ew); if (s > 0) pairs.push({ qi, ei, s }); }));
  pairs.sort((x, y) => y.s - x.s);
  const qUsed = new Set<number>(), eUsed = new Set<number>();
  let num = 0, qMass = 0, eMass = 0, strongHit = false;
  for (const p of pairs) {
    if (qUsed.has(p.qi) || eUsed.has(p.ei)) continue;
    qUsed.add(p.qi); eUsed.add(p.ei);
    const qw = q[p.qi], ew = e[p.ei];
    const initial = qw.length === 1 || ew.length === 1;
    // An initial stands for the whole word, so it weighs what that word weighs.
    const w = initial ? weightOf(qw.length === 1 ? ew : qw) : Math.max(weightOf(qw), weightOf(ew));
    num += w * p.s; qMass += w; eMass += w;
    if (!initial && p.s >= 0.9 && strong(qw) && strong(ew)) strongHit = true;
  }
  q.forEach((w, i) => { if (!qUsed.has(i)) qMass += w.length === 1 ? 0.5 : weightOf(w); });
  e.forEach((w, i) => { if (!eUsed.has(i)) eMass += w.length === 1 ? 0.5 : weightOf(w); });
  const s = (200 * num) / (qMass + eMass);
  return strongHit ? s : Math.min(s, NO_STRONG_CAP);
}

/**
 * The listed parties a name resembles, best first (at most `limit`, scores of 50 and up), one row per listed party.
 * A hit is `matches[0].score >= HIT_THRESHOLD`. `queryNorm` is the already-normalised name.
 */
export function screenName(idx: SanctionIndex, queryNorm: string, limit = 5): Match[] {
  const q = wordsOf(queryNorm);
  if (!q.length) return [];
  const best = new Map<string, { score: number; via: Indexed }>();
  const offer = (row: Indexed, s: number) => {
    const k = `${row.list}:${row.externalId}`, cur = best.get(k);
    if (!cur || s > cur.score) best.set(k, { score: s, via: row });
  };
  // Exact: the same words in any order. A single common word on its own never makes a hit, but a full match of two or more words does:
  // missing a listed person is worse than sending a common name to a reviewer, who clears it with a date of birth or an ID.
  const exact = idx.byKey.get(keyOf(q));
  const lone = q.length === 1 && !strong(q[0]);
  for (const row of exact ?? []) offer(row, lone ? WEAK_ALONE_CAP : 100);
  // Fuzzy: only entries sharing (or nearly sharing) a distinctive query word are worth scoring.
  const sims = new Map<string, number>();
  const seen = new Set<Indexed>(exact);
  for (const qw of q.filter(strong)) {
    for (const t of idx.byLetter.get(qw[0]) ?? []) {
      if (wordSim(qw, t) === 0) continue;
      for (const row of idx.byToken.get(t)!) { if (seen.has(row)) continue; seen.add(row); offer(row, score(q, row.tokens, sims)); }
    }
  }
  return [...best.values()]
    .map(({ score: s, via }) => ({ s: Math.round(s), via }))
    .filter((x) => x.s >= 50)
    .sort((a, b) => b.s - a.s).slice(0, limit)
    .map(({ s, via }) => {
      const main = idx.primary.get(`${via.list}:${via.externalId}`) ?? via;
      return { score: s, list: via.list, externalId: via.externalId, kind: main.kind, program: main.program, country: main.country, listedName: main.name, matchedName: via.name, viaAlias: via.isAlias };
    });
}
