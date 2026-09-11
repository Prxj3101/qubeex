// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit");

export interface PayslipPdfParams {
  institutionName: string;
  institutionLogoUrl?: string | null;
  staffName: string;
  staffDesignation: string;
  month: string; // "2026-10"
  earnings: { label: string; amount: number }[];
  deductions: { label: string; amount: number }[];
  grossPay: number;
  netPay: number;
  bankDetails?: { accountName: string; accountNumber: string; ifsc: string; bankName: string } | null;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

function formatRupees(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-IN")}`;
}

// Standard single-page payslip — earnings/deductions side by side, gross/net
// summary, bank details for the teacher's own reference. Follows the same
// pdfkit buffer-collection pattern as marksheet.controller.ts's PDF
// generators (doc.on("data"/"end"/"error"), Buffer.concat, doc.end()).
export async function generatePayslipPdf(params: PayslipPdfParams): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const startX = doc.page.margins.left;

    doc.fontSize(16).font("Helvetica-Bold").fillColor("#1a1a1a")
      .text(params.institutionName, startX, doc.y, { align: "center", width: pageWidth });
    doc.fontSize(11).font("Helvetica").fillColor("#555")
      .text(`Payslip — ${monthLabel(params.month)}`, { align: "center", width: pageWidth });
    doc.moveDown(1);

    doc.fontSize(10).font("Helvetica-Bold").fillColor("#1a1a1a").text("Name:", startX, doc.y, { continued: true });
    doc.font("Helvetica").text(`  ${params.staffName}`);
    doc.font("Helvetica-Bold").text("Designation:", startX, doc.y, { continued: true });
    doc.font("Helvetica").text(`  ${params.staffDesignation || "—"}`);
    doc.moveDown(1);

    const colWidth = pageWidth / 2 - 10;
    const tableTop = doc.y;

    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Earnings", startX, tableTop, { width: colWidth });
    doc.text("Deductions", startX + colWidth + 20, tableTop, { width: colWidth });
    let y = tableTop + 18;

    doc.font("Helvetica").fontSize(9);
    const maxRows = Math.max(params.earnings.length, params.deductions.length);
    for (let i = 0; i < maxRows; i++) {
      const e = params.earnings[i];
      const d = params.deductions[i];
      if (e) doc.text(`${e.label}: ${formatRupees(e.amount)}`, startX, y, { width: colWidth });
      if (d) doc.text(`${d.label}: ${formatRupees(d.amount)}`, startX + colWidth + 20, y, { width: colWidth });
      y += 16;
    }

    y += 10;
    doc.moveTo(startX, y).lineTo(startX + pageWidth, y).strokeColor("#ccc").stroke();
    y += 12;

    doc.font("Helvetica-Bold").fontSize(11);
    doc.text(`Gross Pay: ${formatRupees(params.grossPay)}`, startX, y, { width: colWidth });
    doc.fillColor("#1a7a1a").text(`Net Pay: ${formatRupees(params.netPay)}`, startX + colWidth + 20, y, { width: colWidth });
    doc.fillColor("#1a1a1a");
    y += 30;

    if (params.bankDetails) {
      doc.font("Helvetica-Bold").fontSize(10).text("Bank Details (for reference)", startX, y);
      y += 16;
      doc.font("Helvetica").fontSize(9);
      doc.text(`Account Name: ${params.bankDetails.accountName}`, startX, y); y += 14;
      doc.text(`Account Number: ${params.bankDetails.accountNumber}`, startX, y); y += 14;
      doc.text(`IFSC: ${params.bankDetails.ifsc}`, startX, y); y += 14;
      doc.text(`Bank: ${params.bankDetails.bankName}`, startX, y); y += 14;
    }

    doc.fontSize(7).fillColor("#999")
      .text("This is a system-generated payslip and does not require a signature.", startX, doc.page.height - doc.page.margins.bottom - 20, { align: "center", width: pageWidth });

    doc.end();
  });
}
