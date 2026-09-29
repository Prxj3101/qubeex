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

  describe("Provident Fund", () => {
    const pf = { ceiling: 2500000, capWages: true, employeeRate: 1200, employerRate: 1200, epsRate: 833, edliRate: 50, adminRate: 50 };
    const withDa = [...components, { id: "da", name: "DA", type: "EARNING" as const, calcType: "PERCENT_OF_BASIC" as const, isBasic: false, lopApplicable: true, pfApplicable: true, sortOrder: 5 }];

    it("PF on Basic + DA under the ceiling", () => {
      // Basic 20,000 + DA 10% (2,000) = PF wages 22,000 (HRA / Transport not counted)
      const r = calculateSalary({ month: "2026-09", components: withDa, dayBasis: "CALENDAR", pf,
        items: [...items, { componentId: "da", value: 1000 }] });
      expect(r.pfWages).toBe(2200000);
      expect(r.deductions.find((l) => l.label === "PF (Employee)")!.amount).toBe(264000); // 12% = 2,640
      expect(r.employer.find((l) => l.label === "EPS (Pension)")!.amount).toBe(183260); // 8.33% = 1,832.60
      expect(r.employer.find((l) => l.label === "EPF (Employer)")!.amount).toBe(264000 - 183260);
      expect(r.netPay).toBe(3150000 - 20000 - 264000); // employer part is not deducted
    });

    it("caps at the ₹25,000 ceiling", () => {
      const r = calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", pf,
        items: [{ componentId: "basic", value: 4000000 }] });
      expect(r.deductions.find((l) => l.label === "PF (Employee)")!.amount).toBe(300000); // 12% of 25,000
      expect(r.employer.find((l) => l.label === "EPS (Pension)")!.amount).toBe(208250); // 8.33% of 25,000
    });

    it("no EPS (e.g. age 58+): the full employer 12% goes to EPF", () => {
      const r = calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", pf: { ...pf, epsRate: 0 },
        items: [{ componentId: "basic", value: 2000000 }] });
      expect(r.employer.find((l) => l.label === "EPS (Pension)")).toBeUndefined();
      expect(r.employer.find((l) => l.label === "EPF (Employer)")!.amount).toBe(240000); // 12% of 20,000
      expect(r.employer.find((l) => l.label === "EDLI")!.amount).toBe(10000); // EDLI still applies
    });

    it("on full wages when the school chooses not to cap (EPS still capped)", () => {
      const r = calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", pf: { ...pf, capWages: false },
        items: [{ componentId: "basic", value: 4000000 }] });
      expect(r.deductions.find((l) => l.label === "PF (Employee)")!.amount).toBe(480000); // 12% of 40,000
      expect(r.employer.find((l) => l.label === "EPS (Pension)")!.amount).toBe(208250);
      expect(r.employer.find((l) => l.label === "EPF (Employer)")!.amount).toBe(480000 - 208250);
    });

    it("uses the wages actually earned after LOP", () => {
      const r = calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", pf, lopDays: 3,
        items: [{ componentId: "basic", value: 1500000 }] });
      // earned Basic 15,000 * 27/30 = 13,500 -> PF 1,620
      expect(r.pfWages).toBe(1350000);
      expect(r.deductions.find((l) => l.label === "PF (Employee)")!.amount).toBe(162000);
    });

    it("no PF lines when PF doesn't apply", () => {
      const r = calculateSalary({ month: "2026-09", items, components, dayBasis: "CALENDAR" });
      expect(r.employer).toEqual([]);
      expect(r.pfWages).toBe(0);
      expect(r.deductions.some((l) => l.label.startsWith("PF"))).toBe(false);
    });
  });

  describe("ESI", () => {
    const esi = { wageLimit: 2100000, employeeRate: 75, employerRate: 325 };
    it("0.75% / 3.25% of gross when within ₹21,000, rounded up to the rupee", () => {
      // Basic 12,000 + Transport 1,500 = 13,500 gross
      const r = calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", esi,
        items: [{ componentId: "basic", value: 1200000 }, { componentId: "transport", value: 150000 }] });
      expect(r.deductions.find((l) => l.label === "ESI (Employee)")!.amount).toBe(10200); // 101.25 -> 102
      expect(r.employer.find((l) => l.label === "ESI (Employer)")!.amount).toBe(43900); // 438.75 -> 439
    });
    it("not covered when the normal gross is above ₹21,000", () => {
      const r = calculateSalary({ month: "2026-09", items, components, dayBasis: "CALENDAR", esi }); // 29,500
      expect(r.deductions.some((l) => l.label.startsWith("ESI"))).toBe(false);
      expect(r.employer).toEqual([]);
    });
    it("low daily wage (≤ ₹176/day): only the employer pays", () => {
      const r = calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", esi, items: [{ componentId: "basic", value: 500000 }] });
      expect(r.deductions.some((l) => l.label === "ESI (Employee)")).toBe(false);
      expect(r.employer.find((l) => l.label === "ESI (Employer)")!.amount).toBe(16300); // 162.50 -> 163
    });
  });

  describe("Professional Tax (Maharashtra slabs)", () => {
    const pt = { slabs: [{ from: 0, amount: 0 }, { from: 750100, amount: 17500 }, { from: 1000100, amount: 20000, febAmount: 30000 }] };
    const basic = (rupees: number) => [{ componentId: "basic", value: rupees * 100 }];
    it("picks the slab by gross earned", () => {
      expect(calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", pt, items: basic(7000) }).deductions).toEqual([]);
      expect(calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", pt, items: basic(9000) }).deductions)
        .toEqual([{ label: "Professional Tax", amount: 17500 }]);
      expect(calculateSalary({ month: "2026-09", components, dayBasis: "CALENDAR", pt, items: basic(20000) }).deductions)
        .toEqual([{ label: "Professional Tax", amount: 20000 }]);
    });
    it("₹300 in February", () => {
      expect(calculateSalary({ month: "2027-02", components, dayBasis: "CALENDAR", pt, items: basic(20000) }).deductions)
        .toEqual([{ label: "Professional Tax", amount: 30000 }]);
    });
    it("skips an old fixed Professional Tax component (no double PT)", () => {
      const r = calculateSalary({ month: "2026-09", items, components, dayBasis: "CALENDAR", pt }); // items include the ₹200 PT component
      expect(r.deductions.filter((l) => l.label === "Professional Tax")).toEqual([{ label: "Professional Tax", amount: 20000 }]);
    });
  });
});
