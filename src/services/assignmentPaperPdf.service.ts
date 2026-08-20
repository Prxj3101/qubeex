// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit");

export interface AssignmentPaperPdfQuestion {
  id: string;
  type: string;
  question: string;
  options: string[];
  sectionId: string | null;
  marks: number;
  order: number;
}

export interface AssignmentPaperPdfSection {
  id: string;
  title?: string;
  instruction?: string;
}

export interface AssignmentPaperPdfData {
  assignment: {
    title: string;
    description: string | null;
    subjectName: string;
    className: string;
    totalMarks: number;
    dueDate: Date | null;
    answerSpace: boolean;
    sections: AssignmentPaperPdfSection[];
  };
  questions: AssignmentPaperPdfQuestion[];
  student: { name: string; rollNo: string; studentId: string };
  institution: { name: string; logoUrl: string | null; address: string | null; city: string | null; state: string | null; pincode: string | null } | null;
}

// Exact same colour theme the paper builder uses for an ASSIGNMENT paper
// (TasksTab.tsx PaperBuilder — `theme` object, non-TEST branch) — keeps the
// downloaded PDF visually identical to the on-screen builder/student view.
const PAPER_BORDER = "#A8C0DC";
const TOP_BAR_1 = "#1A2F4A";
const TOP_BAR_2 = "#2563EB";
const TITLE_COLOR = "#0D1B2A";
const META_COLOR = "#1E3A5F";
const ACCENT_COLOR = "#2563EB";
const SECTION_META = "#4A7AAA";
const ROW_BORDER = "#DDEAFB";
const MARKS_BADGE_BG = "#DDEAFB";
const MARKS_BADGE_TEXT = "#1E3A5F";
const MARKS_BADGE_BORDER = "#A8C0DC";
const FOOTER_TEXT = "#4A7AAA";

function fmtDateTime(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}

// Mirrors the paper builder's read view (TasksTab.tsx renderFlowBlock, case
// 'header' / 'sectionHeader' / 'assignmentQuestion' / 'footer') as closely as
// pdfkit allows — same top/bottom colour bars, same letterhead block, same
// numbering scheme (Q{n}.), same MCQ/CONCEPTUAL A/B/C/D options grid, same
// ruled answer-space lines for NUMERICAL/SHORT_ANSWER — but static (no edit
// controls) and personalised per-student like a test.
export async function generateAssignmentPaperPdf(data: AssignmentPaperPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 0, size: "A4", layout: "portrait" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  const logoBuffer = data.institution?.logoUrl ? await fetchImageBuffer(data.institution.logoUrl) : null;

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const MARGIN_X = 40;
    const pageFullW = doc.page.width;
    const pageW = pageFullW - MARGIN_X * 2;

    const drawTopBars = () => {
      doc.rect(0, 0, pageFullW, 6).fill(TOP_BAR_1);
      doc.rect(0, 6, pageFullW, 2).fill(TOP_BAR_2);
    };
    const drawBottomBars = () => {
      const y = doc.page.height - 8;
      doc.rect(0, y, pageFullW, 2).fill(TOP_BAR_2);
      doc.rect(0, y + 2, pageFullW, 6).fill(TOP_BAR_1);
    };

    drawTopBars();
    doc.y = 20;

    // ── Letterhead ───────────────────────────────────────────────────────
    if (data.institution) {
      const letterheadTop = doc.y;
      const textX = logoBuffer ? MARGIN_X + 90 : MARGIN_X;
      const textW = logoBuffer ? pageW - 180 : pageW;
      if (logoBuffer) {
        try { doc.image(logoBuffer, MARGIN_X, letterheadTop, { width: 72, height: 72, fit: [72, 72] }); } catch { /* skip if not a decodable image */ }
      }
      doc.font("Helvetica-Bold").fontSize(20).fillColor(TITLE_COLOR)
        .text(data.institution.name.toUpperCase(), textX, letterheadTop + (logoBuffer ? 10 : 0), { align: "center", width: textW, characterSpacing: 0.4 });
      const addrParts = [data.institution.address, data.institution.city, data.institution.state, data.institution.pincode].filter(Boolean);
      if (addrParts.length > 0) {
        doc.font("Helvetica").fontSize(9.5).fillColor(SECTION_META)
          .text(addrParts.join(", "), textX, doc.y + 4, { align: "center", width: textW });
      }
      doc.y = Math.max(doc.y, letterheadTop + 72) + 12;
      doc.moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + pageW, doc.y).lineWidth(1.5).strokeColor(PAPER_BORDER).stroke();
      doc.moveTo(MARGIN_X, doc.y + 2).lineTo(MARGIN_X + pageW, doc.y + 2).lineWidth(1.5).strokeColor(PAPER_BORDER).stroke();
      doc.y += 16;
    }

    // ── Header block — title, description, due/marks meta row, student ────
    doc.font("Helvetica-Bold").fontSize(16).fillColor(TITLE_COLOR).text(data.assignment.title, MARGIN_X, doc.y, { align: "center", width: pageW });
    if (data.assignment.description) {
      doc.font("Helvetica").fontSize(9).fillColor(SECTION_META)
        .text(data.assignment.description, MARGIN_X, doc.y + 4, { align: "center", width: pageW });
    }
    doc.moveDown(1.5);

    const metaY = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor(META_COLOR);
    const subjectPrefix = data.assignment.subjectName ? `Subject: ${data.assignment.subjectName}      ` : "";
    doc.text(`${subjectPrefix}Due: ${data.assignment.dueDate ? fmtDateTime(data.assignment.dueDate) : "Not set"}`, MARGIN_X, metaY, { lineBreak: false });
    doc.font("Helvetica").fontSize(10).fillColor(META_COLOR)
      .text(`Total Questions: ${data.questions.length}`, MARGIN_X, metaY, { width: pageW, align: "right", lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(12).fillColor(ACCENT_COLOR)
      .text(`Total Marks: ${data.assignment.totalMarks}`, MARGIN_X, metaY + 14, { width: pageW, align: "right" });
    doc.y = metaY + 14;
    doc.moveDown(0.6);

    doc.moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + pageW, doc.y).lineWidth(1.5).strokeColor(PAPER_BORDER).stroke();
    doc.moveDown(0.6);

    // ── Questions, grouped by section (unsectioned questions render as a
    // flat numbered list first, matching the builder's flow) ─────────────
    const bySection = new Map<string | null, AssignmentPaperPdfQuestion[]>();
    for (const q of data.questions) {
      const key = q.sectionId;
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key)!.push(q);
    }

    let qNum = 0;
    const ensureSpace = (needed: number) => {
      if (doc.y + needed > doc.page.height - 20) {
        drawBottomBars();
        doc.addPage({ margin: 0, size: "A4" });
        drawTopBars();
        doc.y = 20;
      }
    };

    const renderQuestion = (q: AssignmentPaperPdfQuestion) => {
      qNum += 1;
      ensureSpace(40);
      const qY = doc.y;
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ACCENT_COLOR).text(`Q${qNum}.`, MARGIN_X, qY, { continued: true, width: 24 });
      doc.font("Helvetica").fontSize(9.5).fillColor(TITLE_COLOR).text(` ${q.question}`, { width: pageW - 40 });

      const marksLabel = `[${q.marks}m]`;
      doc.roundedRect(MARGIN_X + pageW - 32, qY - 2, 32, 13, 2).lineWidth(0.5).fillAndStroke(MARKS_BADGE_BG, MARKS_BADGE_BORDER);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MARKS_BADGE_TEXT)
        .text(marksLabel, MARGIN_X + pageW - 32, qY + 1, { width: 32, align: "center", lineBreak: false });

      if ((q.type === "MCQ" || q.type === "CONCEPTUAL") && q.options.length > 0) {
        doc.moveDown(0.3);
        const optX = MARGIN_X + 20;
        const colW = (pageW - 20) / 2;
        q.options.forEach((opt, i) => {
          const col = i % 2, row = Math.floor(i / 2);
          const ox = optX + col * colW;
          const oy = doc.y + row * 13;
          doc.font("Helvetica").fontSize(8.5).fillColor(META_COLOR)
            .text(`${String.fromCharCode(65 + i)}) ${opt}`, ox, oy, { width: colW - 10, lineBreak: false });
        });
        doc.y += Math.ceil(q.options.length / 2) * 13 + 4;
      } else if (q.type === "TRUE_FALSE") {
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(8.5).fillColor(META_COLOR)
          .text(`A) True      B) False`, MARGIN_X + 20, doc.y);
        doc.moveDown(0.2);
      } else if (data.assignment.answerSpace && q.type === "NUMERICAL") {
        doc.moveDown(1.2);
        doc.moveTo(MARGIN_X + 20, doc.y).lineTo(MARGIN_X + 20 + pageW * 0.55, doc.y).lineWidth(0.5).strokeOpacity(0.4).strokeColor(META_COLOR).stroke();
        doc.strokeOpacity(1);
        doc.moveDown(0.4);
      } else if (data.assignment.answerSpace && q.type === "SHORT_ANSWER") {
        for (let i = 0; i < 3; i++) {
          doc.moveDown(1.1);
          doc.moveTo(MARGIN_X + 20, doc.y).lineTo(MARGIN_X + pageW, doc.y).lineWidth(0.5).strokeOpacity(0.22).strokeColor(META_COLOR).stroke();
          doc.strokeOpacity(1);
        }
        doc.moveDown(0.4);
      } else {
        doc.moveDown(0.5);
      }
      doc.moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + pageW, doc.y).lineWidth(0.5).strokeColor(ROW_BORDER).stroke();
      doc.moveDown(0.3);
    };

    const renderSection = (sectionId: string | null, qs: AssignmentPaperPdfQuestion[], first: boolean) => {
      const meta = sectionId ? data.assignment.sections.find((s) => s.id === sectionId) : null;
      if (meta) {
        ensureSpace(30);
        if (!first) doc.moveDown(1.2);
        const sectionMarks = qs.reduce((s, q) => s + q.marks, 0);
        const rowY = doc.y;
        doc.font("Helvetica-Bold").fontSize(11).fillColor(TITLE_COLOR)
          .text((meta.title ?? "Section").toUpperCase(), MARGIN_X, rowY, { characterSpacing: 0.4, lineBreak: false });
        if (qs.length > 0) {
          doc.font("Helvetica-Bold").fontSize(9).fillColor(SECTION_META)
            .text(`${qs.length} Q. ${sectionMarks} mks`, MARGIN_X, rowY + 1, { width: pageW, align: "right", lineBreak: false });
        }
        doc.y = rowY + 16;
        doc.moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + pageW, doc.y).lineWidth(1).strokeColor(PAPER_BORDER).stroke();
        doc.moveDown(0.6);
      }
      qs.sort((a, b) => a.order - b.order).forEach(renderQuestion);
    };

    // Unsectioned first (matches how the builder flows a paper with no
    // sections, or a mix), then each section in the order it was defined.
    let first = true;
    if (bySection.has(null)) { renderSection(null, bySection.get(null)!, first); first = false; }
    for (const sec of data.assignment.sections) {
      if (bySection.has(sec.id)) { renderSection(sec.id, bySection.get(sec.id)!, first); first = false; }
    }

    // ── Footer ───────────────────────────────────────────────────────────
    ensureSpace(30);
    doc.moveDown(0.3);
    doc.moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + pageW, doc.y).lineWidth(1).strokeColor(PAPER_BORDER).stroke();
    doc.moveDown(0.3);
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(FOOTER_TEXT)
      .text("— End of Assignment —", MARGIN_X, doc.y, { continued: true, width: pageW / 2 });
    doc.font("Helvetica").fontSize(9).fillColor(FOOTER_TEXT)
      .text(`Total: ${data.assignment.totalMarks} marks`, MARGIN_X + pageW / 2, doc.y, { width: pageW / 2, align: "right" });

    drawBottomBars();
    doc.end();
  });
}
