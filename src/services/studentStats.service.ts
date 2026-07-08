import { prisma } from "../utils/prisma";

export interface SubjectPerf {
  name: string;
  code: string;
  color: string | null;
  scored: number;
  max: number;
  pct: number | null;
}

export interface StudentStatsData {
  attendance: { present: number; total: number; pct: number | null };
  score: { pct: number | null };
  classRank: number | null;
  subjects: SubjectPerf[];
}

export async function getStudentStatsData(
  studentId: string,
  divisionId: string,
  institutionId: string
): Promise<StudentStatsData> {
  const attendanceRecords = await prisma.attendance.findMany({
    where: { studentId, divisionId, institutionId },
    select: { status: true },
  });
  const attendanceTotal = attendanceRecords.length;
  const attendancePresent = attendanceRecords.filter((r) => r.status === "P").length;
  const attendancePct = attendanceTotal > 0
    ? Math.round((attendancePresent / attendanceTotal) * 100)
    : null;

  const [marksheet, division] = await Promise.all([
    prisma.marksheet.findFirst({
      where: { divisionId, institutionId, status: "PUBLISHED" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        examColumns: { select: { id: true, subjectId: true, maxMarks: true } },
      },
    }),
    prisma.division.findFirst({
      where: { id: divisionId, institutionId },
      select: { standardId: true },
    }),
  ]);

  let scorePct: number | null = null;
  let classRank: number | null = null;
  const subjects: SubjectPerf[] = [];

  if (marksheet) {
    const columnIds = marksheet.examColumns.map((c) => c.id);
    const maxTotal = marksheet.examColumns.reduce((sum, c) => sum + c.maxMarks, 0);

    if (columnIds.length > 0 && maxTotal > 0) {
      const [allScores, studentScores] = await Promise.all([
        prisma.marksheetScore.findMany({
          where: { marksheetId: marksheet.id, institutionId },
          select: { studentId: true, score: true, isAbsent: true },
        }),
        prisma.marksheetScore.findMany({
          where: { marksheetId: marksheet.id, institutionId, studentId },
          select: { examColumnId: true, score: true, isAbsent: true },
        }),
      ]);

      const totals = new Map<string, number>();
      for (const s of allScores) {
        if (!s.isAbsent && s.score !== null) {
          totals.set(s.studentId, (totals.get(s.studentId) ?? 0) + s.score);
        }
      }

      const studentTotal = totals.get(studentId) ?? null;
      if (studentTotal !== null) {
        scorePct = Math.round((studentTotal / maxTotal) * 100);
        const higher = [...totals.values()].filter((t) => t > studentTotal).length;
        classRank = higher + 1;
      }

      if (division) {
        const subjectRows = await prisma.subject.findMany({
          where: { standardId: division.standardId, institutionId },
          orderBy: { order: "asc" },
          select: { id: true, name: true, code: true, color: true },
        });
        const scoreByCol = new Map(studentScores.map((s) => [s.examColumnId, s]));
        for (const sub of subjectRows) {
          const cols = marksheet.examColumns.filter((c) => c.subjectId === sub.id);
          if (cols.length === 0) continue;
          let scored = 0, max = 0;
          for (const col of cols) {
            const e = scoreByCol.get(col.id);
            if (e?.isAbsent) { max += col.maxMarks; continue; }
            if (e?.score != null) { scored += e.score; }
            max += col.maxMarks;
          }
          subjects.push({
            name: sub.name,
            code: sub.code ?? sub.name.slice(0, 4),
            color: sub.color ?? null,
            scored,
            max,
            pct: max > 0 ? Math.round((scored / max) * 100) : null,
          });
        }
      }
    }
  }

  return {
    attendance: { present: attendancePresent, total: attendanceTotal, pct: attendancePct },
    score: { pct: scorePct },
    classRank,
    subjects,
  };
}
