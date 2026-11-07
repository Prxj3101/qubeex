import { borrowerTypeForRole, computeDueAt, computeLateFinePaise, normaliseCode, RuleSet } from "./library.rules";

const rule: RuleSet = { maxBooks: 2, loanDays: 14, maxRenewals: 1, finePerDayPaise: 200, graceDays: 0, fineCapPaise: null };
const d = (s: string) => new Date(`${s}T10:00:00.000Z`);

describe("computeLateFinePaise", () => {
  test("returned exactly on the due date costs nothing", () => {
    expect(computeLateFinePaise(d("2026-11-10"), d("2026-11-10"), rule)).toBe(0);
  });
  test("returned later the same day costs nothing", () => {
    expect(computeLateFinePaise(d("2026-11-10"), new Date("2026-11-10T23:00:00.000Z"), rule)).toBe(0);
  });
  test("grace days absorb a short delay", () => {
    expect(computeLateFinePaise(d("2026-11-10"), d("2026-11-11"), { ...rule, graceDays: 1 })).toBe(0);
  });
  test("5 days late with 2 grace days at 200 per day is 600", () => {
    expect(computeLateFinePaise(d("2026-11-10"), d("2026-11-15"), { ...rule, graceDays: 2 })).toBe(600);
  });
  test("cap limits the fine", () => {
    expect(computeLateFinePaise(d("2026-11-10"), d("2026-11-15"), { ...rule, fineCapPaise: 500 })).toBe(500);
  });
  test("zero rate never fines", () => {
    expect(computeLateFinePaise(d("2026-11-10"), d("2026-12-15"), { ...rule, finePerDayPaise: 0 })).toBe(0);
  });
  test("returned early never goes negative", () => {
    expect(computeLateFinePaise(d("2026-11-10"), d("2026-11-01"), rule)).toBe(0);
  });
});

describe("computeDueAt", () => {
  test("adds whole calendar days", () => {
    expect(computeDueAt(d("2026-11-30"), 14).toISOString()).toBe("2026-12-14T10:00:00.000Z");
  });
});

describe("normaliseCode", () => {
  test("trims whitespace and upper-cases", () => {
    expect(normaliseCode("  lib-000012\n")).toBe("LIB-000012");
  });
});

describe("borrowerTypeForRole", () => {
  test("maps roles to borrower types", () => {
    expect(borrowerTypeForRole("STUDENT")).toBe("STUDENT");
    expect(borrowerTypeForRole("TEACHER")).toBe("TEACHER");
    expect(borrowerTypeForRole("ADMIN")).toBe("STAFF");
    expect(borrowerTypeForRole("SUB_ADMIN")).toBe("STAFF");
  });
  test("super admin is not a borrower", () => {
    expect(() => borrowerTypeForRole("SUPER_ADMIN")).toThrow();
  });
});
