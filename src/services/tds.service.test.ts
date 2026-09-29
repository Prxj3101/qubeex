import { annualTax, computeMonthlyTds, fyMonthIndex, fyRange } from "./tds.service";

const R = (rupees: number) => rupees * 100;

describe("income tax (FY 2026-27)", () => {
  it("new regime: nil up to ₹12L taxable (87A rebate)", () => {
    expect(annualTax(R(12_00_000), "NEW")).toBe(0);
  });
  it("new regime: marginal relief just above ₹12L", () => {
    // slab tax on 12.5L = 67,500 but capped at the income above 12L (50,000) + 4% cess
    expect(annualTax(R(12_50_000), "NEW")).toBe(R(52_000));
  });
  it("new regime: ₹13L and ₹14.25L taxable", () => {
    expect(annualTax(R(13_00_000), "NEW")).toBe(R(78_000)); // 75,000 + cess
    expect(annualTax(R(14_25_000), "NEW")).toBe(R(97_500)); // 93,750 + cess
  });
  it("old regime: rebate up to ₹5L, slabs above", () => {
    expect(annualTax(R(5_00_000), "OLD")).toBe(0);
    expect(annualTax(R(7_00_000), "OLD")).toBe(R(54_600)); // 12,500 + 40,000 = 52,500 + cess
  });
  it("financial year helpers", () => {
    expect(fyMonthIndex("2026-04")).toBe(1);
    expect(fyMonthIndex("2026-09")).toBe(6);
    expect(fyMonthIndex("2027-03")).toBe(12);
    expect(fyRange("2027-02")).toEqual({ from: "2026-04", to: "2027-03" });
  });
});

describe("monthly TDS", () => {
  const base = {
    regime: "NEW" as const, hasPan: true, declaration: {},
    currentPt: 0, currentEmployeePf: 0, normalMonthlyPt: 0, normalMonthlyEmployeePf: 0,
    pastTaxable: 0, pastPt: 0, pastEmployeePf: 0, pastTds: 0,
  };
  it("no TDS when the yearly salary stays under ₹12.75L (new regime)", () => {
    const r = computeMonthlyTds({ ...base, month: "2026-04", currentTaxable: R(1_00_000), normalMonthlyGross: R(1_00_000) }); // 12L a year
    expect(r.monthlyTds).toBe(0);
  });
  it("spreads the yearly tax over the months left", () => {
    // ₹1.25L a month from April = 15L a year -> taxable 14.25L -> tax 97,500 -> /12
    const r = computeMonthlyTds({ ...base, month: "2026-04", currentTaxable: R(1_25_000), normalMonthlyGross: R(1_25_000) });
    expect(r.info.taxableIncome).toBe(R(14_25_000));
    expect(r.monthlyTds).toBe(R(8_125));
  });
  it("mid-year: takes off TDS already deducted", () => {
    // September (7 months left incl. Sept); 5 months already paid at 1.25L with 8,125 TDS each
    const r = computeMonthlyTds({ ...base, month: "2026-09", currentTaxable: R(1_25_000), normalMonthlyGross: R(1_25_000),
      pastTaxable: R(6_25_000), pastTds: R(40_625) });
    expect(r.info.monthsLeft).toBe(7);
    expect(r.monthlyTds).toBe(R(8_125));
  });
  it("old regime uses PF, PT and declared deductions", () => {
    const r = computeMonthlyTds({ ...base, regime: "OLD", month: "2026-04", currentTaxable: R(60_000), normalMonthlyGross: R(60_000),
      currentPt: R(200), normalMonthlyPt: R(200), currentEmployeePf: R(1_800), normalMonthlyEmployeePf: R(1_800),
      declaration: { sec80C: R(50_000), sec80D: R(25_000) } });
    // income 7.2L - (50k std + 2.4k PT + 80C min(1.5L, 21.6k+50k) + 25k) = 5,70,960 -> rounded 5,70,960
    expect(r.info.deductions).toBe(R(50_000 + 2_400 + 71_600 + 25_000));
    expect(r.info.taxableIncome).toBe(R(5_71_000));
  });
  it("without PAN: at least 20% of this month's salary when tax is due", () => {
    const r = computeMonthlyTds({ ...base, hasPan: false, month: "2026-04", currentTaxable: R(1_25_000), normalMonthlyGross: R(1_25_000) });
    expect(r.monthlyTds).toBe(R(25_000));
    expect(r.info.noPanRule).toBe(true);
  });
  it("school started QubeEx mid-year: earlier months are assumed at the normal salary", () => {
    // October, April-September not in QubeEx (6 months assumed) -> same yearly tax as a full year of 1.25L
    const r = computeMonthlyTds({ ...base, month: "2026-10", currentTaxable: R(1_25_000), normalMonthlyGross: R(1_25_000),
      assumedPastMonths: 6, declaration: { tdsBeforeQubeex: R(48_750) } });
    expect(r.info.estimatedAnnualIncome).toBe(R(15_00_000));
    expect(r.info.annualTax).toBe(R(97_500));
    expect(r.monthlyTds).toBe(R(8_125)); // (97,500 - 48,750) / 6
  });
});
