import { dayType, statusFromPunches, lopFromSummary, summarise, daysOfMonth, datesBetween, type StaffStatus } from "./staffAttendance.service";

const rules = { officeStart: "08:00", graceMinutes: 10, halfDayMinutes: 240 };
const offs = { weeklyOffDays: [0], offSaturdays: [2, 4] };

describe("staff attendance", () => {
  it("first punch is check-in, last is check-out, duplicates ignored", () => {
    expect(statusFromPunches(["14:32:10", "07:55:02", "07:55:40", "12:00:00"], rules)).toEqual({ status: "PRESENT", checkIn: "07:55", checkOut: "14:32" });
  });

  it("late after office start + grace", () => {
    expect(statusFromPunches(["08:10:00", "14:30:00"], rules).status).toBe("PRESENT"); // exactly at the grace limit
    expect(statusFromPunches(["08:11:00", "14:30:00"], rules).status).toBe("LATE");
  });

  it("half day when worked less than the half-day minutes", () => {
    expect(statusFromPunches(["08:00:00", "11:30:00"], rules).status).toBe("HALF_DAY");
  });

  it("a single punch has no check-out and is not a half day", () => {
    expect(statusFromPunches(["07:58:00"], rules)).toEqual({ status: "PRESENT", checkIn: "07:58", checkOut: null });
  });

  it("no punches = absent", () => {
    expect(statusFromPunches([], rules).status).toBe("ABSENT");
  });

  it("weekly offs, 2nd/4th Saturday and holidays", () => {
    const holidays = new Set(["2026-10-02"]);
    expect(dayType("2026-10-04", offs, holidays)).toBe("WEEKLY_OFF"); // Sunday
    expect(dayType("2026-10-03", offs, holidays)).toBe("WORKING"); // 1st Saturday
    expect(dayType("2026-10-10", offs, holidays)).toBe("WEEKLY_OFF"); // 2nd Saturday
    expect(dayType("2026-10-24", offs, holidays)).toBe("WEEKLY_OFF"); // 4th Saturday
    expect(dayType("2026-10-02", offs, holidays)).toBe("HOLIDAY");
    expect(dayType("2026-10-05", offs, holidays)).toBe("WORKING");
  });

  it("summary counts only working days; unmarked days are separate", () => {
    const dates = daysOfMonth("2026-10");
    const marks = new Map<string, StaffStatus>([["2026-10-05", "ABSENT"], ["2026-10-06", "HALF_DAY"], ["2026-10-07", "LATE"], ["2026-10-08", "UNPAID_LEAVE"], ["2026-10-09", "PAID_LEAVE"], ["2026-10-04", "ABSENT"]]);
    const sum = summarise(dates, marks, (d) => dayType(d, offs, new Set()) === "WORKING" && d <= "2026-10-09");
    // working days 1..9 Oct except Sun 4th: 1,2,3,5,6,7,8,9 = 8; the Sunday "absent" is ignored
    expect(sum).toMatchObject({ workingDays: 8, absent: 1, halfDay: 1, late: 1, unpaidLeave: 1, paidLeave: 1, unmarked: 3 });
  });

  it("LOP = absent + unpaid leave + half days x 0.5 (+ late rule)", () => {
    const sum = { workingDays: 26, present: 18, late: 7, halfDay: 1, absent: 2, paidLeave: 1, unpaidLeave: 1, unmarked: 0 };
    expect(lopFromSummary(sum, { lateRuleEnabled: false, lateRuleCount: 3 })).toBe(3.5);
    expect(lopFromSummary(sum, { lateRuleEnabled: true, lateRuleCount: 3 })).toBe(4.5); // 7 lates -> 2 x half day
  });

  it("date helpers", () => {
    expect(daysOfMonth("2026-02")).toHaveLength(28);
    expect(datesBetween("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});
