// Reading company documents (registration certificate, PAN card, incorporation certificate, Udyam certificate, bank letter) and comparing
// what they say with what the company declared. A mismatch is not a rejection: it is a note for the person who reviews the company.
import { market } from "../../../lib/countries";
import { findDate } from "./parse";

export type DocFields = Partial<Record<"taxId" | "legalName" | "tradeName" | "registeredOn" | "companyReg" | "incorporatedOn" | "udyam" | "enterpriseType" | "bankAccount" | "bankCode" | "holderName", string>>;

const core = (re: RegExp) => re.source.replace(/^\^|\$$/g, "");
const clean = (s: string) => s.replace(/^[\s:\-–|]+/, "").replace(/\s{2,}.*$/, "").trim();
const lines = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

/** The text after a label, on the same line or the next. */
function after(ls: string[], label: RegExp): string | null {
  for (let i = 0; i < ls.length; i++) {
    const m = label.exec(ls[i]);
    if (!m) continue;
    const same = clean(ls[i].slice(m.index + m[0].length));
    if (same.length >= 3) return same;
    if (ls[i + 1] && clean(ls[i + 1]).length >= 3) return clean(ls[i + 1]);
  }
  return null;
}
const name = (s: string | null) => (s && /[A-Za-z]{3}/.test(s) ? s.replace(/\b(?:gstin|tpin|pan|cin|address|trade name|legal name).*$/i, "").trim().slice(0, 100) || null : null);

export function parseDocument(kind: string, text: string): DocFields {
  const ls = lines(text);
  const ids = market().ids;
  const out: DocFields = {};
  const find = (re: RegExp, flags = "i") => new RegExp(`\\b${core(re)}\\b`, flags).exec(text)?.[0].toUpperCase();
  if (kind === "tax_registration") {
    const labelled = new RegExp(`${ids.taxReg.label.replace(/[^A-Za-z0-9 ]/g, "")}[^A-Za-z0-9]{0,10}(${core(ids.taxReg.pattern)})`, "i").exec(text)?.[1]
      ?? (ids.taxReg.label === "GSTIN" ? find(ids.taxReg.pattern) : undefined);
    if (labelled) out.taxId = labelled.toUpperCase();
    out.legalName = name(after(ls, /legal\s*name(?:\s*of\s*business)?|taxpayer'?s?\s*name|name\s*of\s*(?:the\s*)?(?:taxpayer|business|company)|registered\s*name/i)) ?? undefined;
    out.tradeName = name(after(ls, /trade\s*name/i)) ?? undefined;
    const reg = after(ls, /date\s*of\s*registration|registered\s*on|effective\s*date/i);
    if (reg && findDate(reg)) out.registeredOn = findDate(reg)!;
  } else if (kind === "tax_id") {
    const id = ids.kyb.label === "PAN" ? find(ids.kyb.pattern) : new RegExp(`${ids.kyb.label}[^A-Za-z0-9]{0,10}(${core(ids.kyb.pattern)})`, "i").exec(text)?.[1];
    if (id) out.taxId = id.toUpperCase();
    out.legalName = name(after(ls, /\bname\b(?!\s*of\s*father)|business\s*name|taxpayer/i)) ?? undefined;
  } else if (kind === "incorporation") {
    if (ids.companyReg) {
      // The strict Indian CIN can be spotted anywhere; a loose pattern (Zambia) needs a label in front of it.
      const label = `${ids.companyReg.label.replace(/[^A-Za-z0-9 ]/g, "")}|registration\\s*(?:no\\.?|number)|company\\s*(?:no\\.?|number)|corporate\\s*identity\\s*number`;
      const labelled = new RegExp(`(?:${label})[^A-Za-z0-9]{0,10}(${core(ids.companyReg.pattern)})`, "i").exec(text)?.[1] ?? (ids.companyReg.label === "CIN" ? find(ids.companyReg.pattern) : undefined);
      if (labelled) out.companyReg = labelled.toUpperCase();
    }
    out.legalName = name(after(ls, /name\s*of\s*(?:the\s*)?(?:company|entity|business)|company\s*name|m\/s\.?|entity\s*name/i)) ?? undefined;
    const d = after(ls, /date\s*of\s*incorporation|incorporated\s*on|registered\s*on/i);
    if (d && findDate(d)) out.incorporatedOn = findDate(d)!;
  } else if (kind === "udyam" && ids.msme) {
    const u = find(ids.msme.pattern);
    if (u) out.udyam = u;
    out.legalName = name(after(ls, /name\s*of\s*(?:the\s*)?enterprise|enterprise\s*name/i)) ?? undefined;
    const t = /\b(micro|small|medium)\b/i.exec(text);
    if (t) out.enterpriseType = t[1].toLowerCase();
  } else if (kind === "bank_proof") {
    const acct = /(?:a\/c|account)\s*(?:no\.?|number|#)?[\s:.-]*([0-9][0-9 ]{6,22}[0-9])/i.exec(text)?.[1]?.replace(/\s/g, "");
    if (acct && ids.bankAccount.pattern.test(acct)) out.bankAccount = acct;
    const code = find(ids.bankCode.pattern);
    if (code) out.bankCode = code;
    out.holderName = name(after(ls, /account\s*holder|a\/c\s*holder|account\s*name|beneficiary|in\s*the\s*name\s*of/i)) ?? undefined;
  }
  for (const k of Object.keys(out) as (keyof DocFields)[]) if (!out[k]) delete out[k];
  return out;
}

// ---- comparing with what the company declared ---------------------------------------------------------------------------------

const SUFFIX = /\b(?:private|pvt|limited|ltd|llp|llc|plc|inc|company|co|corporation|corp|and|the|of|m\/s|proprietor|prop)\b\.?/gi;
const tokens = (s: string) => s.toLowerCase().replace(SUFFIX, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1);

/** Do two business names plausibly name the same company? Ignores "Pvt Ltd" style words, order and punctuation. */
export function sameName(a: string, b: string): boolean {
  const x = new Set(tokens(a)), y = new Set(tokens(b));
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((t) => y.has(t)).length;
  return shared / Math.min(x.size, y.size) >= 0.75 && shared / Math.max(x.size, y.size) >= 0.5;
}

export type Declared = { legalName: string; tradeName?: string | null; kybTaxId?: string | null; taxReg?: string | null; companyReg?: string | null; udyam?: string | null; bankAccount?: string | null; bankCode?: string | null };

/** Things for the reviewer to look at: where the document disagrees with the declaration, and what could not be read. */
export function compareDocument(kind: string, f: DocFields, d: Declared): string[] {
  const flags: string[] = [];
  const L = market().ids;
  const diff = (what: string, onDoc: string | undefined, declared: string | null | undefined) => {
    if (!onDoc || !declared) return;
    if (onDoc.replace(/\s/g, "").toUpperCase() !== declared.replace(/\s/g, "").toUpperCase()) flags.push(`The ${what} on the document (${onDoc}) differs from the one declared (${declared}).`);
  };
  const nameVs = (onDoc: string | undefined) => { if (onDoc && !sameName(onDoc, d.legalName) && !(d.tradeName && sameName(onDoc, d.tradeName))) flags.push(`The name on the document ("${onDoc}") does not match the declared name ("${d.legalName}").`); };
  if (kind === "tax_registration") { diff(L.taxReg.label, f.taxId, d.taxReg); nameVs(f.legalName); }
  else if (kind === "tax_id") { diff(L.kyb.label, f.taxId, d.kybTaxId); nameVs(f.legalName); }
  else if (kind === "incorporation") { if (L.companyReg) diff(L.companyReg.label, f.companyReg, d.companyReg); nameVs(f.legalName); }
  else if (kind === "udyam") { if (L.msme) diff(L.msme.label, f.udyam, d.udyam); nameVs(f.legalName); }
  else if (kind === "bank_proof") { diff("account number", f.bankAccount, d.bankAccount); diff(L.bankCode.label, f.bankCode, d.bankCode); nameVs(f.holderName); }
  if (Object.keys(f).length === 0) flags.push("Nothing could be read from this document. A person should look at it.");
  return flags;
}
