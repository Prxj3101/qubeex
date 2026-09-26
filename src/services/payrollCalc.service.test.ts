import { calculateSalary, employedDaysInMonth, structureForMonth, CalcComponent } from "./payrollCalc.service";

const components: CalcComponent[] = [
  { id: "basic", name: "Basic", type: "EARNING", calcType: "FIXED", isBasic: true, lopApplicable: true, sortOrder: 0 },
  { id: "hra", name: "HRA", type: "EARNING", calcType: "PERCENT_OF_BASIC", isBasic: false, lopApplicable: true, sortOrder: 1 },
  { id: "transport", name: "Transport", type: "EARNING", calcType: "FIXED", isBasic: false, lopApplicable: false, sortOrder: 2 },
  { id: "pt", name: "Professional Tax", type: "DEDUCTION", calcType: "FIXED", isBasic: false, lopApplicable: false, sortOrder: 3 },
  { id: "pf", name: "PF", type: "DEDUCTION", calcType: "PERCENT_OF_BASIC", isBasic: false, lopApplicable: false, sortOrder: 4 },
];

// Basic ₹20,000 + HRA 40% + Transport ₹1,500, PT ₹200 (all in paise / basis points)
const items = [
  { componentId: "basic", value: 2000000 },
  { componentId: "hra", value: 4000 },
  { componentId: "transport", value: 150000 },
  { componentId: "pt", value: 20000 },
];

describe("payroll calculation", () => {
  it("full month, no LOP", () => {
    const r = calculateSalary({ month: "2026-09", items, components, dayBasis: "CALENDAR" });
    expect(r.earnings).toEqual([
      { label: "Basic", amount: 2000000 },
      { label: "HRA", amount: 800000 },
      { label: "Transport", amount: 150000 },
    ]);
    expect(r.grossPay).toBe(2950000);
    expect(r.netPay).toBe(2930000);
    expect(r.paidDays).toBe(30);
  });

  it("2 LOP days show as a Loss of Pay deduction on LOP-applicable heads only", () => {
    const r = calculateSalary({ month: "2026-09", items, components, dayBasis: "CALENDAR", lopDays: 2 });
    // Earnings stay at the full month; LOP = (20000 - 18666.67) + (8000 - 7466.67) = 1866.66
    expect(r.earnings.find((l) => l.label === "Basic")!.amount).toBe(2000000);
    expect(r.earnings.find((l) => l.label === "HRA")!.amount).toBe(800000);
    expect(r.earnings.find((l) => l.label === "Transport")!.amount).toBe(150000);
    expect(r.deductions[0]).toEqual({ label: "Loss of Pay (2 days)", amount: 186666 });
    expect(r.grossPay).toBe(2950000);
    expect(r.netPay).toBe(2743334); // same take-home as cutting the earnings directly
    expect(r.paidDays).toBe(28);
  });

  it("FIXED_26 basis uses 26 days for one day's salary", () => {
    const r = calculateSalary({ month: "2026-09", items, components, dayBasis: "FIXED_26", lopDays: 1 });
    expect(r.basisDays).toBe(26);
    const lopBasic = 2000000 - Math.round(2000000 * 25 / 26);
    const lopHra = 800000 - Math.round(800000 * 25 / 26);
    expect(r.deductions[0]).toEqual({ label: "Loss of Pay (1 day)", amount: lopBasic + lopHra });
  });

  it("joining mid-month prorates every earning (non-LOP heads by calendar days)", () => {
    const r = calculateSalary({
      month: "2026-09", items, components, dayBasis: "CALENDAR",
      joinedAt: new Date("2026-09-16T00:00:00.000Z"),
    });
    expect(r.employedDays).toBe(15);
    expect(r.earnings[0].amount).toBe(1000000); // half of Basic
    expect(r.earnings[2].amount).toBe(75000); // half of Transport
  });

  it("percent deductions use the Basic actually earned", () => {
    const r = calculateSalary({
      month: "2026-09", components, dayBasis: "CALENDAR", lopDays: 3,
      items: [{ componentId: "basic", value: 1500000 }, { componentId: "pf", value: 1200 }],
    });
    // Basic 15000 * 27/30 = 13500 → PF 12% = 1620; LOP 3 days = 1500
    expect(r.deductions).toEqual([{ label: "Loss of Pay (3 days)", amount: 150000 }, { label: "PF", amount: 162000 }]);
  });

  it("adds one-off adjustments", () => {
    const r = calculateSalary({
      month: "2026-09", items, components, dayBasis: "CALENDAR",
      adjustments: [{ label: "Diwali Bonus", type: "EARNING", amount: 500000 }, { label: "Advance", type: "DEDUCTION", amount: 100000 }],
    });
    expect(r.grossPay).toBe(3450000);
    expect(r.netPay).toBe(3450000 - 20000 - 100000);
  });

  it("LOP can never make pay negative", () => {
    const r = calculateSalary({ month: "2026-09", items, components, dayBasis: "CALENDAR", lopDays: 40 });
    expect(r.paidDays).toBe(0);
    // Transport (not LOP-applicable) is still paid; PT still deducted
    expect(r.netPay).toBe(150000 - 20000);
  });

  it("employed days handle exit dates and people outside the month", () => {
    expect(employedDaysInMonth("2026-02", null, new Date("2026-02-10T00:00:00.000Z"))).toBe(10);
    expect(employedDaysInMonth("2026-02", new Date("2026-03-01T00:00:00.000Z"), null)).toBe(0);
    expect(employedDaysInMonth("2026-02", null, new Date("2026-01-31T00:00:00.000Z"))).toBe(0);
  });

  it("picks the salary version in force for a month", () => {
    const versions = [
      { id: "v1", effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
      { id: "v2", effectiveFrom: new Date("2026-06-01T00:00:00.000Z") },
    ];
    expect(structureForMonth(versions, "2026-05")!.id).toBe("v1");
    expect(structureForMonth(versions, "2026-06")!.id).toBe("v2");
    expect(structureForMonth(versions, "2025-12")).toBeUndefined();
  });
});
