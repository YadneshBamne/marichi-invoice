import { describe, expect, it } from "vitest";
import { ALT_CSV, EU_XML, SDN_CSV, UN_XML } from "./fixtures";
import { parseEuFsf, parseOfacSdn, parseUnConsolidated } from "./lists";
import { normalizeName } from "./normalize";
import { buildIndex, HIT_THRESHOLD, screenName } from "./screen";

const entries = [...parseOfacSdn(SDN_CSV, ALT_CSV), ...parseUnConsolidated(UN_XML), ...parseEuFsf(EU_XML)].map((e) => ({ ...e, norm: normalizeName(e.name) }));
const idx = buildIndex(entries);
const top = (name: string) => screenName(idx, normalizeName(name))[0];
const hit = (name: string) => (top(name)?.score ?? 0) >= HIT_THRESHOLD;

describe("screenName: true positives", () => {
  it("default threshold is 88", () => expect(HIT_THRESHOLD).toBe(88));
  it.each([
    ["exact primary name", "Bank Melli Iran"],
    ["exact alias", "Osama Bin Laden"],
    ["reordered", "Melli Iran Bank"],
    ["reordered, comma style", "Ayman, Al-Zawahiri"],
    ["with honorific and suffix", "Dr. Ayman Al Zawahiri Pvt Ltd"],
    ["transliteration (Usama / Ladin)", "Usama Bin Ladin"],
    ["one-letter typo", "Ayman Al Zawahri"],
    ["initial for a first name", "A. Al Zawahiri"],
    ["missing particle", "Ayman Zawahiri"],
    ["accents and spelling (Qusay)", "Qusay Saddam Husain Al Tikriti"],
    ["accented source name", "Qoussai Saddam Hussein Al Tikriti"],
    ["entity alias with a slash", "ADF NALU"],
    ["UN entity alias", "Allied Democratic Forces"],
    ["EU enterprise alias", "Black September"],
    ["hyphenated alias", "Aero Caribbean"],
    ["upper case", "ABU SAYYAF GROUP"],
  ])("%s: %s", (_why, name) => {
    expect(hit(name), `${name} scored ${top(name)?.score}`).toBe(true);
  });

  it("names the entry, list and alias", () => {
    const m = top("Osama Bin Laden");
    expect(m).toMatchObject({ score: 100, list: "ofac_sdn", externalId: "90001", viaAlias: true, listedName: "BIN LADIN, Usama bin Muhammad bin Awad", matchedName: "BIN LADEN, Osama", program: "SDGT" });
    expect(top("Black September")).toMatchObject({ list: "eu", externalId: "EU.3502.46", listedName: "Arab Revolutionary Brigades", country: "LY" });
  });
  it("returns one row per listed party, best first", () => {
    const m = screenName(idx, normalizeName("Saddam Hussein Al Tikriti"));
    expect(m.map((x) => x.list).sort()).toEqual(["eu", "un"]);
    expect(m[0].score).toBeGreaterThanOrEqual(m[1].score);
  });
});

describe("screenName: true negatives", () => {
  it.each([
    "Ali", "Trading", "Ali Trading", "Hassan Ali Trading", "Khan", "Al", "Company", "Co", "Mr",
    "Rajesh Kumar Sharma", "Priya Singh", "Mohammed Ali Khan", "Mohammed Hassan Ali", "Anil Ambani", "Sunita Devi",
    "Tata Consultancy Services Limited", "Bharat Retail Pvt Ltd", "Sharma & Sons", "Reliance Industries Limited", "Infosys Ltd",
    "Seller Co", "Big Corp", "Ayman Kumar", "Saddam Mulenga", "Bank of Baroda", "National Bank of India",
    "Chanda Mulenga", "Mwansa Phiri", "Zambia Sugar Plc", "Mwansa Phiri Enterprises", "Lusaka Trading Company", "Kafue Gorge Limited", "Bwalya Banda",
    "Melli", "Iran Trading Company", "Majeed Trading Company", "Airlines", "Caribbean Holidays",
  ])("%s", (name) => {
    expect(hit(name), `${name} scored ${top(name)?.score}`).toBe(false);
  });

  it("a single common word never matches, even exactly", () => {
    const small = buildIndex([{ list: "un", externalId: "1", name: "ALI", norm: "ali", kind: "individual", isAlias: true, program: null, country: null }]);
    expect(screenName(small, "ali")[0].score).toBeLessThan(HIT_THRESHOLD);
  });
  it("a shared common word alone is capped well below the threshold", () => {
    expect(top("Ali Trading")?.score ?? 0).toBeLessThan(76);
  });
  it("a full match of common words is a hit for a reviewer, but a near-miss first name is not", () => {
    const row = { list: "ofac_sdn", externalId: "1", name: "GUPTA, Rajesh", norm: normalizeName("GUPTA, Rajesh"), kind: "individual", isAlias: false, program: null, country: null };
    const small = buildIndex([row]);
    const s = (n: string) => screenName(small, normalizeName(n))[0]?.score ?? 0;
    expect(s("Rajesh Gupta")).toBeGreaterThanOrEqual(HIT_THRESHOLD); // exact full name: a reviewer decides whether it is the same person
    expect(s("Gupta Rajesh")).toBeGreaterThanOrEqual(HIT_THRESHOLD);
    expect(s("Ramesh Gupta")).toBeLessThan(HIT_THRESHOLD);
  });
  it("an empty or unusable name matches nothing", () => {
    expect(screenName(idx, "")).toEqual([]);
    expect(screenName(idx, normalizeName("---"))).toEqual([]);
  });
});

describe("screenName: speed", () => {
  it("handles a list of tens of thousands of entries", () => {
    const big = Array.from({ length: 40_000 }, (_, i) => {
      const name = `${["Alpha", "Beta", "Gamma", "Delta", "Omar", "Ali", "Khan"][i % 7]} ${["Trading", "Zorn", "Vex", "Quill"][i % 4]}${i} Holdings`;
      return { list: "ofac_sdn", externalId: `${i}`, name, norm: normalizeName(name), kind: "entity", isAlias: false, program: null, country: null };
    });
    const bigIdx = buildIndex([...big, ...entries]);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) screenName(bigIdx, normalizeName("Omar Ali Khan Trading"));
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(screenName(bigIdx, normalizeName("Osama Bin Laden"))[0].score).toBe(100);
  });
});
