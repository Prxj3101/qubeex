import { getAcademicYear } from "./promotion.utils";

describe("getAcademicYear", () => {
  it("returns the April-start year when the date is in April or later", () => {
    expect(getAcademicYear(new Date("2026-06-15"))).toBe("2026-27");
    expect(getAcademicYear(new Date("2026-04-01"))).toBe("2026-27");
  });

  it("returns the prior year's cycle when the date is before April", () => {
    expect(getAcademicYear(new Date("2026-02-10"))).toBe("2025-26");
    expect(getAcademicYear(new Date("2026-03-31"))).toBe("2025-26");
  });

  it("wraps the two-digit end year correctly across a century boundary", () => {
    expect(getAcademicYear(new Date("2099-05-01"))).toBe("2099-00");
  });
});
