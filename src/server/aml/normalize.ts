// Name normalisation for sanctions screening. The SAME function runs on every list entry (when it is stored) and on every name
// being checked, so the two sides always compare like with like.
//   "Mr. Mohammed AL-Tikriti Pvt. Ltd." -> "muhamad al tikriti"

// Words that say what a person or company is, not who: dropped (as long as something else is left).
const NOISE = new Set([
  "mr", "mrs", "ms", "miss", "mx", "shri", "shree", "sri", "smt", "kumari", "dr", "prof", "sir", "hon", "late", "haji", "hajji",
  "pvt", "private", "ltd", "limited", "llc", "inc", "incorporated", "co", "company", "corp", "corporation", "llp", "lp", "plc", "fze", "fzc",
  "fzco", "gmbh", "sa", "sarl", "sas", "ag", "bv", "nv", "pte", "sdn", "bhd", "ooo", "jsc", "ojsc", "pjsc", "zao", "the", "and", "of",
]);

// Spellings of the same name that differ by more than one letter (after doubled letters are collapsed).
const SAME: Record<string, string> = {
  mohamed: "muhamad", mohamad: "muhamad", muhamad: "muhamad", muhamed: "muhamad", mohmed: "muhamad", mahomed: "muhamad", mohd: "muhamad", md: "muhamad",
  usama: "osama", abou: "abu", ibn: "bin", el: "al",
};

// Letters that Unicode decomposition leaves alone.
const FOLD: Record<string, string> = { ß: "ss", ø: "o", đ: "d", ł: "l", æ: "ae", œ: "oe", ı: "i", þ: "th", ð: "d" };

/** The words of a name after normalisation, in the order written. Empty if nothing usable is left. */
export function nameTokens(name: string): string[] {
  const folded = name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[ßøđłæœıþð]/g, (c) => FOLD[c]);
  const all = folded
    .replace(/['’`´]/g, "") // O'Brien -> obrien
    .replace(/[^\p{L}\p{N}]+/gu, " ") // punctuation, hyphens, dots, slashes -> a space
    .trim().split(" ").filter(Boolean)
    .map((w) => w.replace(/(\p{L})\1+/gu, "$1")) // doubled letters: mohammed -> mohamed, hussein -> husein
    .map((w) => SAME[w] ?? w);
  const kept = all.filter((w) => !NOISE.has(w));
  return kept.length ? kept : all.filter((w) => w !== "the"); // a name that is only noise ("Co", "Mr") is still compared
}

/** One lower-case string, words separated by single spaces. */
export const normalizeName = (name: string) => nameTokens(name).join(" ");
