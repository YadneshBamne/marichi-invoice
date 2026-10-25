import { describe, expect, it } from "vitest";
import { nameTokens, normalizeName } from "./normalize";

describe("normalizeName", () => {
  it("strips accents, punctuation and case", () => {
    expect(normalizeName("Qoussaï  O'BRIEN-Al.Tikriti")).toBe("qousai obrien al tikriti");
  });
  it("drops honorifics and company suffixes", () => {
    expect(normalizeName("Mr. Rajesh Kumar")).toBe("rajesh kumar");
    expect(normalizeName("Shri Ramesh Gupta")).toBe("ramesh gupta");
    expect(normalizeName("Bharat Retail Pvt. Ltd.")).toBe("bharat retail");
    expect(normalizeName("Acme Private Limited")).toBe("acme");
  });
  it("folds spelling variants the same way on both sides", () => {
    expect(normalizeName("Mohammed")).toBe(normalizeName("Muhammad"));
    expect(normalizeName("Usama bin Ladin")).toBe(normalizeName("Osama ibn Ladin"));
    expect(normalizeName("Straße")).toBe("strase");
  });
  it("keeps a name that is only noise, and handles empty input", () => {
    expect(normalizeName("Co")).toBe("co");
    expect(normalizeName("  --  ")).toBe("");
    expect(nameTokens("")).toEqual([]);
  });
  it("keeps non-Latin letters", () => {
    expect(normalizeName("Сергей Иванов")).toBe("сергеи иванов");
  });
});
