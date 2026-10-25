// Parsers for the three public sanctions lists. Each turns the list's published file into entries: one per primary name and one
// per alias. No account, no key, no vendor.
//
// OFAC SDN (US Treasury). Flat files "sdn.csv" (one row per listed party) and "alt.csv" (one row per alias), no header row, fields
// quoted, "-0- " for an empty field, rows end with CRLF and the file ends with a Ctrl-Z byte. Format notes and downloads:
//   https://ofac.treasury.gov/specially-designated-nationals-list-data-formats-data-schemas  (redirects to https://sanctionslist.ofac.treas.gov/Home/SdnList)
//   sdn.csv columns: ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag, Vess_owner, Remarks
//   alt.csv columns: ent_num, alt_num, alt_type, alt_name, alt_remarks
//   The advanced XML is about 100 MB, so the CSV pair is used. Checked against real downloads of both files on 2026-10-25;
//   the column names above come from OFAC's published spec, the order from the real files.
// UN Security Council consolidated list (XML). Root CONSOLIDATED_LIST with INDIVIDUALS/INDIVIDUAL and ENTITIES/ENTITY. Names are in
//   FIRST_NAME .. FOURTH_NAME (an entity's whole name is in FIRST_NAME); aliases in INDIVIDUAL_ALIAS/ALIAS_NAME and ENTITY_ALIAS/ALIAS_NAME:
//   https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list   schema: https://scsanctions.un.org/resources/xml/en/consolidated.xsd
//   Checked against a real download on 2026-10-25.
// EU consolidated financial sanctions list (FSF, XML 1.1). Root export with sanctionEntity elements; each has a subjectType (code
//   "person" or "enterprise"), nameAlias elements (attribute wholeName), a regulation (attribute programme) and citizenship / address
//   elements (attribute countryIso2Code):
//   https://webgate.ec.europa.eu/fsd/fsf   (the EU asks for a registration and a token; the token below is the public one that
//   OpenSanctions also publishes at https://www.opensanctions.org/datasets/eu_fsf/ - the EU can change or withdraw it.)
//   Checked against a real download on 2026-10-25.
import { parseCsv } from "../util/csv";
import { parseXml, kids, text, type XNode } from "../util/xml";

export type ListId = "ofac_sdn" | "un" | "eu";
export type ListEntry = { list: ListId; externalId: string; name: string; kind: "individual" | "entity" | "other"; isAlias: boolean; program: string | null; country: string | null };

export const OFAC_SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";
export const OFAC_ALT_URL = "https://www.treasury.gov/ofac/downloads/alt.csv";
export const UN_URL = "https://scsanctions.un.org/resources/xml/en/consolidated.xml";
// UNVERIFIED: the token is public knowledge, not documented by the EU; if the download starts failing, register at the FSF site and set a new one.
export const EU_URL = "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";

const clean = (s: string | undefined) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t === "" || t === "-0-" ? null : t; };

// ---------- OFAC ----------

/** SDN_Type: "individual", "vessel", "aircraft", or "-0- " (empty) for companies and other organisations. */
const ofacKind = (t: string | null): ListEntry["kind"] => (t === "individual" ? "individual" : t === null ? "entity" : "other");

export function parseOfacSdn(sdnCsv: string, altCsv: string): ListEntry[] {
  const rows = (csv: string) => parseCsv(csv.replace(/\x1a/g, "")); // the file ends with a Ctrl-Z byte
  const out: ListEntry[] = [];
  const parent = new Map<string, ListEntry>();
  for (const r of rows(sdnCsv)) {
    const id = clean(r[0]), name = clean(r[1]);
    if (!id || !name) continue;
    // Programs are written "FTO] [SDGT" when there are several.
    const program = clean(r[3])?.replace(/\]\s*\[/g, ", ") ?? null;
    const e: ListEntry = { list: "ofac_sdn", externalId: id, name, kind: ofacKind(clean(r[2])), isAlias: false, program, country: clean(r[9]) };
    out.push(e); parent.set(id, e);
  }
  for (const r of rows(altCsv)) {
    const id = clean(r[0]), name = clean(r[3]), main = id ? parent.get(id) : undefined;
    if (!main || !name) continue; // an alias of a party that is no longer on the list
    out.push({ ...main, name, isAlias: true });
  }
  return out;
}

// ---------- UN ----------

/** Every element with this name, at any depth (matches are not searched inside). */
function all(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const k of n.kids) k.name === name ? out.push(k) : all(k, name, out);
  return out;
}

export function parseUnConsolidated(xml: string): ListEntry[] {
  const root = parseXml(xml);
  const out: ListEntry[] = [];
  const add = (n: XNode, kind: ListEntry["kind"], whole: string, aliasTag: string, country: string | null) => {
    const externalId = text(n, "DATAID") || text(n, "REFERENCE_NUMBER");
    if (!externalId || !whole) return;
    const base = { list: "un" as const, externalId, kind, program: text(n, "UN_LIST_TYPE") || null, country };
    out.push({ ...base, name: whole, isAlias: false });
    for (const a of kids(n, aliasTag)) { const alias = text(a, "ALIAS_NAME"); if (alias) out.push({ ...base, name: alias, isAlias: true }); }
  };
  for (const n of all(root, "INDIVIDUAL")) {
    const whole = ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME"].map((t) => text(n, t)).filter(Boolean).join(" ");
    const nat = kids(n, "NATIONALITY")[0]?.kids.find((k) => k.name === "VALUE")?.text.trim();
    const addr = kids(n, "INDIVIDUAL_ADDRESS").map((a) => text(a, "COUNTRY")).find(Boolean);
    add(n, "individual", whole, "INDIVIDUAL_ALIAS", nat || addr || null);
  }
  for (const n of all(root, "ENTITY")) {
    const addr = kids(n, "ENTITY_ADDRESS").map((a) => text(a, "COUNTRY")).find(Boolean);
    add(n, "entity", text(n, "FIRST_NAME"), "ENTITY_ALIAS", addr || null);
  }
  return out;
}

// ---------- EU ----------

export function parseEuFsf(xml: string): ListEntry[] {
  const out: ListEntry[] = [];
  for (const n of all(parseXml(xml), "sanctionEntity")) {
    const externalId = n.attrs.euReferenceNumber || n.attrs.logicalId;
    if (!externalId) continue;
    const code = kids(n, "subjectType")[0]?.attrs.code;
    const kind: ListEntry["kind"] = code === "person" ? "individual" : code === "enterprise" ? "entity" : "other";
    const program = kids(n, "regulation").map((r) => r.attrs.programme).find(Boolean) || null;
    const place = [...kids(n, "citizenship"), ...kids(n, "address")].map((c) => c.attrs.countryIso2Code).find((c) => c && c !== "00") || null;
    // UNVERIFIED: the file has no "primary name" marker, so the first nameAlias is taken as the primary name.
    const seen = new Set<string>();
    for (const a of kids(n, "nameAlias")) {
      const name = (a.attrs.wholeName || [a.attrs.firstName, a.attrs.middleName, a.attrs.lastName].filter(Boolean).join(" ")).trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ list: "eu", externalId, name, kind, isAlias: seen.size > 1, program, country: place });
    }
  }
  return out;
}
