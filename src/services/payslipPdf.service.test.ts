import { generatePayslipPdf } from "./payslipPdf.service";

describe("generatePayslipPdf", () => {
  it("produces a non-empty PDF buffer starting with the PDF magic bytes", async () => {
    const buffer = await generatePayslipPdf({
      institutionName: "Test School",
      staffName: "Jane Doe",
      staffDesignation: "TCH-0001",
      month: "2026-10",
      earnings: [{ label: "Basic", amount: 30000 }, { label: "HRA", amount: 8000 }],
      deductions: [{ label: "PF", amount: 1200 }],
      grossPay: 38000,
      netPay: 36800,
      bankDetails: { accountName: "Jane Doe", accountNumber: "1234567890", ifsc: "TEST0001234", bankName: "Test Bank" },
    });
    expect(buffer.length).toBeGreaterThan(500);
    // PDF files start with "%PDF-"
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("still produces a valid PDF with no bank details", async () => {
    const buffer = await generatePayslipPdf({
      institutionName: "Test School",
      staffName: "Jane Doe",
      staffDesignation: "TCH-0001",
      month: "2026-10",
      earnings: [{ label: "Basic", amount: 30000 }],
      deductions: [],
      grossPay: 30000,
      netPay: 30000,
    });
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
