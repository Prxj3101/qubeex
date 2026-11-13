import { isOverdue, borrowerTypeForRole, computeDueAt, computeLateFinePaise, normaliseCode, RuleSet } from "./library.rules";

const rule: RuleSet = { maxBooks: 2, loanDays: 14, maxRenewals: 1, finePerDayPaise: 200, graceDays: 0, fineCapPaise: null };
const d = (s: string) => new Date(`${s}T10:00:00.000Z`);

describe("computeLateFinePaise", () => {
  test("returned exactly on the due date costs nothing", () => {
    expect(computeLateFinePaise(d("2026-11-10"), d("2026-11-10"), rule)).toBe(0);
  });
  test("returned later the same day costs nothing", () => {
    expect(computeLateFinePaise(d("2026-11-10"), new Date("2026-11-10T12:00:00.000Z"), rule)).toBe(0);
  });
  test("days are counted in India time: due Monday 10:00 IST, returned Tuesday 03:00 IST is one day late", () => {
    const dueMondayMorningIst = new Date("2026-11-10T04:30:00.000Z");
    const returnedTuesdayEarlyIst = new Date("2026-11-10T21:30:00.000Z");
    expect(computeLateFinePaise(dueMondayMorningIst, returnedTuesdayEarlyIst, rule)).toBe(200);
  });
  test("due Monday 23:00 IST, returned Monday 23:50 IST is still on time", () => {
    expect(computeLateFinePaise(new Date("2026-11-10T17:30:00.000Z"), new Date("2026-11-10T18:20:00.000Z"), rule)).toBe(0);
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

describe("isOverdue", () => {
  test("not overdue on the due day, overdue from the next India day", () => {
    const due = new Date("2026-11-10T04:30:00.000Z"); // 10:00 IST Monday
    expect(isOverdue(due, new Date("2026-11-10T17:00:00.000Z"))).toBe(false); // 22:30 IST Monday
    expect(isOverdue(due, new Date("2026-11-10T19:00:00.000Z"))).toBe(true); // 00:30 IST Tuesday
  });
});
