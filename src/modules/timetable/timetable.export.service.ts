import ExcelJS from "exceljs";
import type { AcademicYear } from "../../generated/prisma/client";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { httpError, loadYearContext, type YearContext } from "./timetable.common";
import { DAY_NAMES, type EngineSlot } from "./timetable.engine";
import { decorateEntries } from "./timetable.studio.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit");

export type ExportKind = "class" | "teacher" | "room" | "master";
export type ExportFormat = "pdf" | "xlsx";

interface Grid {
  title: string;
  subtitle: string;
  days: number[];
  slots: EngineSlot[];
  cells: Map<string, string[]>; // `${day}|${slotId}` → lines
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const FILE_SAFE = /[^a-zA-Z0-9_-]+/g;

async function buildGrids(institutionId: string, year: AcademicYear, ctx: YearContext, kind: ExportKind, id?: string): Promise<Grid[]> {
  const db = academicDb();
  const base = { days: ctx.workingDays, slots: ctx.slots };
  const sub = `Academic year ${year.label}`;
  const lines = (parts: (string | null | undefined)[]) => parts.filter((p): p is string => !!p);

  if (kind === "teacher") {
    if (!id || !ctx.teachers.some((t) => t.id === id)) throw httpError(404, "Teacher not found");
    const rows = await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id, teacherId: id }, select: { id: true } });
    const entries = await decorateEntries(institutionId, rows.map((r) => r.id), ctx);
    const cells = new Map<string, string[]>();
    for (const e of entries) cells.set(`${e.dayOfWeek}|${e.slotId}`, lines([ctx.labels.division(e.divisionId), e.subjectName ?? e.title ?? e.sessionTypeName, e.roomName]));
    return [{ ...base, title: ctx.labels.teacher(id), subtitle: `Teacher timetable · ${sub}`, cells }];
  }
  if (kind === "room") {
    if (!id || !ctx.rooms.has(id)) throw httpError(404, "Room not found");
    const rows = await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id, roomId: id }, select: { id: true } });
    const entries = await decorateEntries(institutionId, rows.map((r) => r.id), ctx);
    const cells = new Map<string, string[]>();
    for (const e of entries) cells.set(`${e.dayOfWeek}|${e.slotId}`, lines([ctx.labels.division(e.divisionId), e.subjectName ?? e.title ?? e.sessionTypeName, e.teacherName]));
    return [{ ...base, title: ctx.labels.room(id), subtitle: `Room timetable · ${sub}`, cells }];
  }

  const divisions = kind === "class"
    ? await db.division.findMany({ where: { id: id ?? "", institutionId }, select: { id: true } })
    : await db.division.findMany({ where: { institutionId }, select: { id: true, standard: { select: { order: true } }, name: true }, orderBy: [{ standard: { order: "asc" } }, { name: "asc" }] });
  if (kind === "class" && !divisions.length) throw httpError(404, "Class/section not found");
  const rows = await db.timetableEntry.findMany({ where: { institutionId, academicYearId: year.id, divisionId: { in: divisions.map((d) => d.id) } }, select: { id: true, divisionId: true } });
  const entries = await decorateEntries(institutionId, rows.map((r) => r.id), ctx);
  const byDiv = new Map<string, typeof entries>();
  for (const e of entries) (byDiv.get(e.divisionId) ?? byDiv.set(e.divisionId, []).get(e.divisionId)!).push(e);
  return divisions.map((d) => {
    const cells = new Map<string, string[]>();
    for (const e of byDiv.get(d.id) ?? []) cells.set(`${e.dayOfWeek}|${e.slotId}`, lines([e.subjectName ?? e.title ?? e.sessionTypeName, e.teacherName, e.roomName]));
    return { ...base, title: ctx.labels.division(d.id), subtitle: `Class timetable · ${sub}`, cells };
  });
}

async function toPdf(institutionName: string, grids: Grid[]): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape", autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    if (!grids.length) { doc.addPage(); doc.fontSize(12).text("No timetable data.", 30, 30); }
    for (const g of grids) {
      doc.addPage();
      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;
      doc.font("Helvetica-Bold").fontSize(15).fillColor("#111").text(institutionName, left, 28, { width, align: "center" });
      doc.font("Helvetica-Bold").fontSize(12).text(g.title, { width, align: "center" });
      doc.font("Helvetica").fontSize(9).fillColor("#555").text(g.subtitle, { width, align: "center" });
      const top = doc.y + 10;
      const labelW = 86;
      const colW = (width - labelW) / Math.max(g.days.length, 1);
      const rowH = Math.min(52, (doc.page.height - top - 40) / Math.max(g.slots.length + 1, 1));
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#111");
      doc.rect(left, top, width, 22).fill("#eef2ff").stroke();
      doc.fillColor("#111").text("Period", left + 4, top + 7, { width: labelW - 8 });
      g.days.forEach((d, i) => doc.text(DAY_NAMES[d], left + labelW + i * colW + 4, top + 7, { width: colW - 8, align: "center" }));
      let y = top + 22;
      for (const s of g.slots) {
        const nonTeaching = s.kind !== "PERIOD";
        doc.rect(left, y, width, rowH).fillAndStroke(nonTeaching ? "#f3f4f6" : "#ffffff", "#c7c7c7");
        doc.fillColor("#111").font("Helvetica-Bold").fontSize(8).text(s.name, left + 4, y + 5, { width: labelW - 8 });
        doc.font("Helvetica").fillColor("#666").text(`${hhmm(s.startMinute)}–${hhmm(s.endMinute)}`, left + 4, y + 16, { width: labelW - 8 });
        g.days.forEach((d, i) => {
          const x = left + labelW + i * colW;
          doc.rect(x, y, colW, rowH).stroke("#c7c7c7");
          const l = g.cells.get(`${d}|${s.id}`);
          if (l?.length) {
            doc.fillColor("#111").font("Helvetica-Bold").fontSize(8).text(l[0], x + 3, y + 4, { width: colW - 6, align: "center", height: rowH - 6 });
            if (l.length > 1) doc.font("Helvetica").fillColor("#444").fontSize(7).text(l.slice(1).join("\n"), x + 3, doc.y, { width: colW - 6, align: "center", height: rowH - 18 });
          } else if (nonTeaching && i === 0) {
            doc.fillColor("#888").font("Helvetica-Oblique").fontSize(8).text(s.kind[0] + s.kind.slice(1).toLowerCase(), x, y + rowH / 2 - 4, { width: colW * g.days.length, align: "center" });
          }
        });
        y += rowH;
      }
      doc.fillColor("#888").font("Helvetica").fontSize(7).text(`Generated by QubeEx · ${new Date().toLocaleDateString("en-IN")}`, left, doc.page.height - 28, { width, align: "right" });
    }
    doc.end();
  });
}

async function toXlsx(institutionName: string, grids: Grid[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "QubeEx";
  const used = new Set<string>();
  for (const g of grids.length ? grids : [{ title: "Timetable", subtitle: "", days: [], slots: [], cells: new Map<string, string[]>() } as Grid]) {
    let name = g.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 28) || "Timetable";
    while (used.has(name)) name = `${name.slice(0, 25)}_${used.size}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.addRow([institutionName]).font = { bold: true, size: 14 };
    ws.addRow([`${g.title} — ${g.subtitle}`]).font = { bold: true };
    ws.addRow([]);
    const head = ws.addRow(["Period", "Time", ...g.days.map((d) => DAY_NAMES[d])]);
    head.font = { bold: true };
    head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } }; });
    for (const s of g.slots) {
      const row = ws.addRow([s.name, `${hhmm(s.startMinute)}–${hhmm(s.endMinute)}`, ...g.days.map((d) => (g.cells.get(`${d}|${s.id}`) ?? []).join("\n") || (s.kind !== "PERIOD" ? s.kind : ""))]);
      row.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
      row.height = 44;
    }
    ws.getColumn(1).width = 14; ws.getColumn(2).width = 14;
    g.days.forEach((_, i) => { ws.getColumn(3 + i).width = 22; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function exportTimetable(institutionId: string, year: AcademicYear, kind: ExportKind, format: ExportFormat, id?: string) {
  const ctx = await loadYearContext(institutionId, year);
  const [institution, grids] = await Promise.all([
    prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } }),
    buildGrids(institutionId, year, ctx, kind, id),
  ]);
  const name = institution?.name ?? "QubeEx";
  const base = `timetable-${kind}${id ? `-${(grids[0]?.title ?? id).replace(FILE_SAFE, "_")}` : ""}-${year.label.replace(FILE_SAFE, "_")}`;
  if (format === "pdf") return { buffer: await toPdf(name, grids), contentType: "application/pdf", filename: `${base}.pdf` };
  return {
    buffer: await toXlsx(name, grids),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: `${base}.xlsx`,
  };
}
