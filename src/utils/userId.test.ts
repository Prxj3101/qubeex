import { deriveInstitutionPrefix, encodeDisambiguator, encodeSequence } from "./userId";

describe("deriveInstitutionPrefix", () => {
  it("takes the first letter of each of up to 4 words, uppercased", () => {
    expect(deriveInstitutionPrefix("St Xavier's High School")).toBe("SXHS");
    expect(deriveInstitutionPrefix("St Francis High School")).toBe("SFHS");
  });

  it("pads with 'X' when the name has fewer than 4 words", () => {
    expect(deriveInstitutionPrefix("Delhi Public School")).toBe("DPSX");
  });

  it("handles a single-word name", () => {
    expect(deriveInstitutionPrefix("Vidyalaya")).toBe("VXXX");
  });

  it("truncates to 4 letters for names with more than 4 words", () => {
    expect(deriveInstitutionPrefix("The Modern International Public School")).toBe("TMIP");
  });
});

describe("encodeDisambiguator", () => {
  it("encodes low values the same as plain decimal", () => {
    expect(encodeDisambiguator(1)).toBe("01");
    expect(encodeDisambiguator(2)).toBe("02");
    expect(encodeDisambiguator(9)).toBe("09");
  });

  it("rolls into letters after 9", () => {
    expect(encodeDisambiguator(10)).toBe("0A");
    expect(encodeDisambiguator(35)).toBe("0Z");
    expect(encodeDisambiguator(36)).toBe("10");
  });

  it("reaches max capacity at 1295 ('ZZ')", () => {
    expect(encodeDisambiguator(1295)).toBe("ZZ");
  });

  it("throws outside the 1-1295 range", () => {
    expect(() => encodeDisambiguator(0)).toThrow();
    expect(() => encodeDisambiguator(1296)).toThrow();
  });
});

describe("encodeSequence", () => {
  it("zero-pads plain decimal for 1-9999", () => {
    expect(encodeSequence(1)).toBe("0001");
    expect(encodeSequence(34)).toBe("0034");
    expect(encodeSequence(1205)).toBe("1205");
    expect(encodeSequence(9999)).toBe("9999");
  });

  it("rolls the 10,000th value into '000A'", () => {
    expect(encodeSequence(10000)).toBe("000A");
  });

  it("continues incrementing the letter suffix after 10000", () => {
    expect(encodeSequence(10001)).toBe("000B");
    expect(encodeSequence(10025)).toBe("000Z");
  });

  it("carries into the next position once the last position exhausts A-Z", () => {
    expect(encodeSequence(10026)).toBe("0010");
  });

  it("throws for sequence < 1", () => {
    expect(() => encodeSequence(0)).toThrow();
  });
});
