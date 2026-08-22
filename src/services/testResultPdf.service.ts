// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit");

export interface TestResultPdfAnswer {
  generatedQuestion: string;
  generatedOptions: string[] | null;
  studentAnswer: string | null;
  correctAnswer: string;
  isCorrect: boolean;
  sectionTitle?: string | null;
  sectionInstruction?: string | null;
  images?: string[] | null;
}

export interface TestResultPdfData {
  studentName: string;
  rollNo: string;
  studentBusinessId: string;
  className: string;
  subjectName: string;
  testTitle: string;
  totalScore: number;
  maxScore: number;
  percentage: number;
  malpracticeFlag: boolean;
  tabChangeCount: number;
  attemptNumber: number;
  maxAttempts?: number | null;
  durationMinutes?: number | null;
  startTime: Date | null;
  endTime: Date | null;
  questionCount: number;
  answers: TestResultPdfAnswer[];
}

// Same thresholds/colors as the on-screen result page's scoreColor(), so the
// PDF reads exactly like the light-mode screen it's a copy of.
function scoreColor(pct: number): string {
  if (pct >= 75) return "#059669";
  if (pct >= 35) return "#F59E0B";
  return "#DC2626";
}

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
function fmtTime(d: Date): string {
  return new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

const BORDER = "#E5E0D5";
const MUTED_BG = "#F1EFEA";
const MUTED_TEXT = "#6B7280";
const FOREGROUND = "#1A1A1A";
const TERRACOTTA = "#C06040";
const TERRACOTTA_TINT = "#F4E6DF"; // ~rgba(192,96,64,0.12) flattened onto white
const EMERALD_BG = "#E4F5EE";
const EMERALD_TEXT = "#059669";
const RED_BG = "#FCE8E8";
const RED_TEXT = "#DC2626";

// pdfkit's default fonts don't reliably render ✓/✗ glyphs (they fall back to
// a dot), so these draw the actual icon shapes as vector paths instead —
// same visual language as the lucide CheckCircle2/XCircle/MinusCircle icons
// used on the screen this PDF mirrors.
function drawCheckIcon(doc: any, cx: number, cy: number, r: number, color: string) {
  doc.circle(cx, cy, r).lineWidth(1.2).strokeColor(color).stroke();
  doc.lineWidth(1.4).strokeColor(color).lineCap("round").lineJoin("round");
  doc.moveTo(cx - r * 0.5, cy + r * 0.05)
    .lineTo(cx - r * 0.1, cy + r * 0.45)
    .lineTo(cx + r * 0.55, cy - r * 0.4)
    .stroke();
  doc.lineCap("butt");
}
function drawCrossIcon(doc: any, cx: number, cy: number, r: number, color: string) {
  doc.circle(cx, cy, r).lineWidth(1.2).strokeColor(color).stroke();
  doc.lineWidth(1.4).strokeColor(color).lineCap("round");
  doc.moveTo(cx - r * 0.4, cy - r * 0.4).lineTo(cx + r * 0.4, cy + r * 0.4).stroke();
  doc.moveTo(cx - r * 0.4, cy + r * 0.4).lineTo(cx + r * 0.4, cy - r * 0.4).stroke();
  doc.lineCap("butt");
}
function drawMinusIcon(doc: any, cx: number, cy: number, r: number, color: string) {
  doc.circle(cx, cy, r).lineWidth(1.2).strokeColor(color).stroke();
  doc.lineWidth(1.4).strokeColor(color).lineCap("round");
  doc.moveTo(cx - r * 0.45, cy).lineTo(cx + r * 0.45, cy).stroke();
  doc.lineCap("butt");
}
// Warning-triangle icon for the malpractice badge — drawn as a path, since
// pdfkit's default fonts don't render the ⚠ glyph (it falls back to a
// mangled "&"-looking character).
function drawWarningIcon(doc: any, cx: number, cy: number, r: number, color: string) {
  doc.lineWidth(1.2).strokeColor(color).lineJoin("round").lineCap("round");
  doc.moveTo(cx, cy - r).lineTo(cx + r * 0.9, cy + r * 0.75).lineTo(cx - r * 0.9, cy + r * 0.75).closePath().stroke();
  doc.lineWidth(1.3).strokeColor(color);
  doc.moveTo(cx, cy - r * 0.15).lineTo(cx, cy + r * 0.3).stroke();
  doc.circle(cx, cy + r * 0.55, 0.7).fill(color);
  doc.lineCap("butt");
}
// Small trophy/award badge for the "Results" page header — a rounded cup
// shape with two handle strokes, echoing the lucide Award icon.
function drawAwardIcon(doc: any, cx: number, cy: number, r: number, color: string) {
  doc.circle(cx, cy - r * 0.15, r * 0.62).lineWidth(1.3).strokeColor(color).stroke();
  doc.lineWidth(1.3).strokeColor(color).lineCap("round");
  doc.moveTo(cx - r * 0.18, cy + r * 0.4).lineTo(cx - r * 0.35, cy + r * 0.85).stroke();
  doc.moveTo(cx + r * 0.18, cy + r * 0.4).lineTo(cx + r * 0.35, cy + r * 0.85).stroke();
  doc.lineCap("butt");
}

// Shared by both the student's own "Download Result PDF" button and the
// teacher's per-row download icon in the Test Results panel — this mirrors
// the on-screen result page (app/student/tasks/tests/[testId]/result/
// [attemptId]/page.tsx) as closely as pdfkit allows: same chip strip, same
// score card layout/colors, same per-question card style — light mode only,
// since a PDF has no dark-mode concept.
export async function generateTestResultPdf(data: TestResultPdfData): Promise<Buffer> {
  // pdfkit's doc.image() needs a Buffer synchronously, so all question images
  // are downloaded up front (skip any that fail rather than breaking the PDF).
  const imageUrls = Array.from(new Set(data.answers.flatMap((a) => a.images ?? [])));
  const imageBuffers = new Map<string, Buffer>();
  await Promise.all(imageUrls.map(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      imageBuffers.set(url, Buffer.from(await resp.arrayBuffer()));
    } catch { /* skip broken/unreachable image */ }
  }));

  const doc = new PDFDocument({ margin: 32, size: "A4", layout: "portrait" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const startX = doc.page.margins.left;
    const col = scoreColor(data.percentage);

    // ── "Results" header ────────────────────────────────────────────────
    drawAwardIcon(doc, startX + 8, doc.y + 5, 8, FOREGROUND);
    doc.font("Helvetica-Bold").fontSize(15).fillColor(FOREGROUND).text("Results", startX + 20, doc.y);
    doc.moveDown(0.4);

    // ── Chip strip: Name · Roll No · Class · Subject · Student ID ──────
    const chips: { text: string; mono?: boolean; color?: string }[] = [
      { text: `Name : ${data.studentName}` },
      { text: `Roll No. ${data.rollNo.padStart(2, "0")}` },
      { text: data.className },
      { text: data.subjectName },
      { text: data.studentBusinessId, mono: true, color: "#DA7756" },
    ];
    let cx = startX;
    const chipY = doc.y;
    let chipRowH = 0;
    chips.forEach((chip) => {
      doc.font(chip.mono ? "Courier-Bold" : "Helvetica").fontSize(8.5);
      const w = doc.widthOfString(chip.text) + 14;
      const h = 18;
      chipRowH = Math.max(chipRowH, h);
      if (cx + w > startX + pageW) { cx = startX; }
      doc.roundedRect(cx, chipY, w, h, 5).fillAndStroke("#FFFFFF", BORDER);
      doc.fillColor(chip.color ?? MUTED_TEXT).text(chip.text, cx + 7, chipY + 5, { lineBreak: false });
      cx += w + 5;
    });
    doc.y = chipY + chipRowH + 10;

    // ── Score card ──────────────────────────────────────────────────────
    const cardY = doc.y;
    const cardH = data.malpracticeFlag ? 128 : 110;
    doc.roundedRect(startX, cardY, pageW, cardH, 10).fillAndStroke("#FFFFFF", BORDER);

    // Top-right badge stack: duration, ques count, attempt, given at, submitted at
    const badges: { label: string; tint?: boolean }[] = [];
    if (data.durationMinutes != null) {
      const h = data.durationMinutes >= 60
        ? `${Math.floor(data.durationMinutes / 60)}hr${data.durationMinutes % 60 ? ` ${data.durationMinutes % 60}mins` : ""}`
        : `${data.durationMinutes}mins`;
      badges.push({ label: h });
    }
    badges.push({ label: `${data.questionCount} Ques` });
    badges.push({ label: `Attempt ${data.attemptNumber}${data.maxAttempts != null ? `/${data.maxAttempts}` : ""}` });
    if (data.startTime) badges.push({ label: `Given at : ${fmtDate(data.startTime)}, ${fmtTime(data.startTime)}`, tint: true });
    if (data.endTime) badges.push({ label: `Submitted at : ${fmtDate(data.endTime)}, ${fmtTime(data.endTime)}`, tint: true });

    let by = cardY + 10;
    const badgeRightEdge = startX + pageW - 10;
    badges.forEach((b) => {
      doc.font("Helvetica").fontSize(7.5);
      const w = doc.widthOfString(b.label) + 12;
      const h = 15;
      const bx = badgeRightEdge - w;
      doc.roundedRect(bx, by, w, h, 5).fill(b.tint ? TERRACOTTA_TINT : MUTED_BG);
      doc.fillColor(b.tint ? TERRACOTTA : MUTED_TEXT).text(b.label, bx + 6, by + 4, { width: w - 12, lineBreak: false });
      by += h + 3;
    });

    // Left: score ring (proportional arc, like the on-screen conic-gradient
    // ring — NOT a solid filled disc) + title + marks + malpractice badge
    const circleCx = startX + 42, circleCy = cardY + 36, ringR = 22, ringW = 6;
    doc.lineWidth(ringW).lineCap("round");
    doc.strokeOpacity(0.15).strokeColor(col);
    doc.circle(circleCx, circleCy, ringR).stroke();
    doc.strokeOpacity(1);
    if (data.percentage > 0) {
      const angleDeg = Math.min(360, data.percentage * 3.6);
      const angleRad = (angleDeg * Math.PI) / 180;
      const arcStartX = circleCx, arcStartY = circleCy - ringR;
      const arcEndX = circleCx + ringR * Math.sin(angleRad);
      const arcEndY = circleCy - ringR * Math.cos(angleRad);
      const largeArc = angleDeg > 180 ? 1 : 0;
      doc.strokeColor(col);
      if (angleDeg >= 360) {
        doc.circle(circleCx, circleCy, ringR).stroke();
      } else {
        doc.path(`M ${arcStartX} ${arcStartY} A ${ringR} ${ringR} 0 ${largeArc} 1 ${arcEndX} ${arcEndY}`).stroke();
      }
    }
    doc.lineWidth(1).lineCap("butt");
    doc.font("Helvetica-Bold").fontSize(11).fillColor(FOREGROUND);
    const pctLineH = doc.currentLineHeight();
    doc.text(`${data.percentage}%`, circleCx - ringR, circleCy - pctLineH / 2, { width: ringR * 2, align: "center" });

    // Title + marks, vertically centered against the ring (ring spans
    // roughly circleCy-ringR to circleCy+ringR, i.e. cardY+24 to cardY+68).
    const textX = startX + 90;
    doc.font("Helvetica-Bold").fontSize(15).fillColor(FOREGROUND)
      .text(data.testTitle, textX, cardY + 14, { width: pageW - 90 - 140 });
    const scoreStr = `${data.totalScore}`;
    doc.font("Helvetica-Bold").fontSize(15).fillColor(FOREGROUND);
    const scoreW = doc.widthOfString(scoreStr);
    doc.text(scoreStr, textX, cardY + 37, { lineBreak: false });
    doc.font("Helvetica").fontSize(9).fillColor(MUTED_TEXT)
      .text(` /${data.maxScore} marks`, textX + scoreW, cardY + 41, { lineBreak: false });

    if (data.malpracticeFlag) {
      const label = "Flagged for malpractice";
      doc.font("Helvetica-Bold").fontSize(8);
      const maxW = pageW - (textX - startX) - 10;
      const w = Math.min(maxW, doc.widthOfString(label) + 26);
      const badgeY = cardY + 60;
      doc.roundedRect(textX, badgeY, w, 16, 8).fill(RED_BG);
      drawWarningIcon(doc, textX + 12, badgeY + 8, 5, RED_TEXT);
      doc.fillColor(RED_TEXT).text(label, textX + 20, badgeY + 4, { width: w - 26, lineBreak: false });
    }

    // Correct / Incorrect / Skipped mini stat boxes, each with its icon
    const correctCount = data.answers.filter((a) => a.isCorrect).length;
    const unansweredCount = data.answers.filter((a) => !a.studentAnswer).length;
    const incorrectCount = data.answers.length - correctCount - unansweredCount;
    const stats: { n: number; label: string; bg: string; fg: string; icon: (d: any, x: number, y: number, r: number, c: string) => void }[] = [
      { n: correctCount, label: "Correct", bg: EMERALD_BG, fg: EMERALD_TEXT, icon: drawCheckIcon },
      { n: incorrectCount, label: "Incorrect", bg: RED_BG, fg: RED_TEXT, icon: drawCrossIcon },
      { n: unansweredCount, label: "Skipped", bg: MUTED_BG, fg: MUTED_TEXT, icon: drawMinusIcon },
    ];
    const statW = 64, statH = 36, statGap = 6;
    stats.forEach((s, i) => {
      const sx = startX + 10 + i * (statW + statGap);
      const sy = data.malpracticeFlag ? cardY + 85 : cardY + cardH - statH - 7;
      doc.roundedRect(sx, sy, statW, statH, 8).fill(s.bg);
      s.icon(doc, sx + statW / 2 - 13, sy + 13, 4.5, s.fg);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(s.fg).text(String(s.n), sx + statW / 2 - 4, sy + 8, { width: 24 });
      doc.font("Helvetica").fontSize(7).fillColor(MUTED_TEXT).text(s.label, sx, sy + 24, { width: statW, align: "center" });
    });

    doc.y = cardY + cardH + 14;

    // ── Per-question breakdown ──────────────────────────────────────────
    let lastSectionTitle: string | null = null;
    data.answers.forEach((a, i) => {
      const cardPad = 10;
      const textW = pageW - cardPad * 2 - 20;
      const imgs0 = (a.images ?? []).map((u) => imageBuffers.get(u)).filter((b): b is Buffer => !!b);

      // Estimate the full card's height (question text + images + answer
      // line(s)) BEFORE drawing anything, so a question with a large image
      // gets pushed onto a fresh page as a whole instead of pdfkit silently
      // auto-paginating mid-draw — that mismatch between the box's start
      // (old page) and end (new page) is what produced the broken/half-circle
      // rounded-rect artifacts.
      // heightOfString measures using the CURRENT font/fontSize (it doesn't
      // accept font/fontSize as options), so set state explicitly before
      // each measurement — matches whatever font each line is later drawn in.
      doc.font("Helvetica-Bold").fontSize(9.5);
      const qTextH = doc.heightOfString(`${i + 1}. ${a.generatedQuestion}`, { width: textW });
      let imagesH = 0;
      if (imgs0.length > 0) {
        const imgSize = 280, imgGap = 6;
        const itemsPerRow = Math.max(1, Math.floor(textW / (imgSize + imgGap)));
        const rows = Math.ceil(imgs0.length / itemsPerRow);
        imagesH = rows * imgSize + (rows - 1) * imgGap + 8;
      }
      doc.font("Helvetica").fontSize(8.5);
      const answerH = doc.heightOfString(`Your answer: ${a.studentAnswer || "—"}`, { width: textW })
        + (!a.isCorrect ? doc.heightOfString(`Correct answer: ${a.correctAnswer}`, { width: textW }) + 2 : 0);
      const estCardH = cardPad * 2 + qTextH + 6 + imagesH + answerH + 9;
      const pageUsableH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

      if (doc.y - doc.page.margins.top + estCardH > pageUsableH && estCardH <= pageUsableH) {
        doc.addPage({ size: "A4", margin: 32 });
      } else if (doc.y > doc.page.height - doc.page.margins.bottom - 90) {
        doc.addPage({ size: "A4", margin: 32 });
      }

      if (a.sectionTitle && a.sectionTitle !== lastSectionTitle) {
        lastSectionTitle = a.sectionTitle;
        // Extra breathing room above a new section's heading, but only when
        // it's not the very first section (i.e. there's a previous question
        // box directly above it to separate from).
        if (i > 0) doc.y += 8;
        const secY = doc.y;
        doc.font("Helvetica-Bold").fontSize(10).fillColor(FOREGROUND)
          .text(a.sectionTitle, startX + 8, secY + 2, { continued: !!a.sectionInstruction });
        if (a.sectionInstruction) {
          doc.font("Helvetica").fontSize(9).fillColor(MUTED_TEXT).text(` : ${a.sectionInstruction}`);
        }
        doc.rect(startX, secY, 3, Math.max(16, doc.y - secY)).fill(TERRACOTTA);
        doc.y = Math.max(doc.y, secY + 16) + 6;
      }

      const boxTopY = doc.y;
      const qStartY = boxTopY + cardPad;
      const iconColor = a.isCorrect ? EMERALD_TEXT : RED_TEXT;
      (a.isCorrect ? drawCheckIcon : drawCrossIcon)(doc, startX + cardPad + 6, qStartY + 5, 4.5, iconColor);
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(FOREGROUND)
        .text(`${i + 1}. ${a.generatedQuestion}`, startX + cardPad + 20, qStartY, { width: pageW - cardPad * 2 - 20 });
      doc.moveDown(0.4);

      // Question images, if any — placed directly under the question text,
      // same as the on-screen result page.
      const imgs = (a.images ?? []).map((u) => imageBuffers.get(u)).filter((b): b is Buffer => !!b);
      if (imgs.length > 0) {
        const imgSize = 280, imgGap = 6;
        const imgX0 = startX + cardPad + 20;
        const availW = pageW - cardPad * 2 - 20;
        let imgX = imgX0;
        let imgRowY = doc.y;
        let rowMaxH = 0;
        imgs.forEach((buf) => {
          if (imgX + imgSize > imgX0 + availW) {
            imgX = imgX0;
            imgRowY += rowMaxH + imgGap;
            rowMaxH = 0;
          }
          // Advance the cursor by the image's actual rendered height (not the
          // full imgSize box) so a landscape/short image doesn't leave a big
          // blank gap before the "Your answer" line below it.
          let renderedH = imgSize;
          try {
            const img = doc.openImage(buf);
            const scale = Math.min(imgSize / img.width, imgSize / img.height);
            renderedH = img.height * scale;
          } catch { /* fall back to full box height */ }
          rowMaxH = Math.max(rowMaxH, renderedH);
          try { doc.image(buf, imgX, imgRowY, { fit: [imgSize, imgSize] }); } catch { /* skip unreadable image */ }
          imgX += imgSize + imgGap;
        });
        doc.y = imgRowY + rowMaxH + 8;
      }

      doc.font("Helvetica").fontSize(8.5).fillColor(a.isCorrect ? "#047857" : "#B91C1C")
        .text(`Your answer: ${a.studentAnswer || "—"}`, startX + cardPad + 20, doc.y, { width: pageW - cardPad * 2 - 20 });
      if (!a.isCorrect) {
        doc.moveDown(0.15);
        doc.font("Helvetica").fontSize(8.5).fillColor(MUTED_TEXT)
          .text(`Correct answer: ${a.correctAnswer}`, startX + cardPad + 20, doc.y, { width: pageW - cardPad * 2 - 20 });
      }
      const boxBottomY = doc.y + cardPad;
      doc.roundedRect(startX, boxTopY, pageW, boxBottomY - boxTopY, 8).stroke(BORDER);
      doc.y = boxBottomY + 9;
    });

    doc.end();
  });
}
