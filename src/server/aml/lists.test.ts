import { describe, expect, it } from "vitest";
import { parseEuFsf, parseOfacSdn, parseUnConsolidated } from "./lists";
import { ALT_CSV, EU_XML, SDN_CSV, UN_XML } from "./fixtures";
import { parseXml } from "../util/xml";

describe("OFAC SDN", () => {
  const rows = parseOfacSdn(SDN_CSV, ALT_CSV);
  it("makes one entry per name and per alias", () => {
    expect(rows).toHaveLength(7 + 4); // 7 parties + 4 aliases; the alias of an unlisted party is dropped
    expect(rows.filter((r) => r.isAlias).map((r) => r.name)).toEqual(["BIN LADEN, Osama", "AL-ZAWAHIRI, Ayman", "MELLI BANK", "AERO-CARIBBEAN"]);
  });
  it("reads kinds, programs and the vessel flag", () => {
    const by = (name: string) => rows.find((r) => r.name === name)!;
    expect(by("AL ZAWAHIRI, Dr. Ayman")).toMatchObject({ list: "ofac_sdn", externalId: "90002", kind: "individual", program: "SDGT", country: null, isAlias: false });
    expect(by("BANK MELLI IRAN")).toMatchObject({ kind: "entity", program: "IRAN, NPWMD" });
    expect(by("EBANO")).toMatchObject({ kind: "other", country: "Panama" });
    expect(by("MELLI BANK")).toMatchObject({ externalId: "90003", kind: "entity", isAlias: true });
  });
  it("copes with CRLF and the trailing Ctrl-Z", () => {
    expect(rows.every((r) => !r.name.includes("\x1a") && r.externalId !== "\x1a")).toBe(true);
  });
});

describe("UN consolidated list", () => {
  const rows = parseUnConsolidated(UN_XML);
  it("joins the name parts and lists every non-empty alias", () => {
    expect(rows.map((r) => [r.externalId, r.name, r.isAlias])).toEqual([
      ["7000001", "SADDAM HUSSEIN AL-TIKRITI", false], ["7000001", "ABU ALI", true],
      ["7000002", "FRANK KAKOLELE BWAMBALE", false], ["7000002", "FRANK KAKORERE", true],
      ["7000003", "ADF", false], ["7000003", "Allied Democratic Forces", true], ["7000003", "ADF/NALU", true],
    ]);
  });
  it("reads kind, program and country", () => {
    expect(rows[0]).toMatchObject({ list: "un", kind: "individual", program: "Iraq", country: "Iraq" });
    expect(rows[2].country).toBe("Democratic Republic of the Congo"); // no nationality: falls back to the address
    expect(rows[4]).toMatchObject({ kind: "entity", program: "DRC", country: "Democratic Republic of the Congo" });
  });
});

describe("EU consolidated list", () => {
  const rows = parseEuFsf(EU_XML);
  it("takes wholeName per nameAlias and skips empty names", () => {
    expect(rows.map((r) => [r.externalId, r.name, r.isAlias])).toEqual([
      ["EU.39.56", "Qoussaï Saddam Hussein Al-Tikriti", false], ["EU.39.56", "Qusay Saddam Hussein Al-Tikriti", true],
      ["EU.3502.46", "Arab Revolutionary Brigades", false], ["EU.3502.46", "Black September", true],
    ]);
  });
  it("reads kind, programme and country", () => {
    expect(rows[0]).toMatchObject({ list: "eu", kind: "individual", program: "IRQ", country: "IQ" });
    expect(rows[2]).toMatchObject({ kind: "entity", program: "TERR", country: "LY" });
  });
});

describe("xml reader attributes", () => {
  it("keeps attributes, including quoted > and entities", () => {
    const root = parseXml(`<a x="1 > 0" y='&amp;z'><b n="2"/></a>`);
    expect(root.kids[0].attrs).toEqual({ x: "1 > 0", y: "&z" });
    expect(root.kids[0].kids[0].attrs.n).toBe("2");
  });
});
