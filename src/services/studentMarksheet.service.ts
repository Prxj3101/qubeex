import { academicDb } from "../utils/academicContext";
import { resolveGrade, GradeScaleEntry } from "./gradeScale";

function gradeFor(pct: number | null, scale: GradeScaleEntry[]): string {
  if (pct === null) return "—";
  return resolveGrade(pct, scale);
}

export interface MarksheetSubjectData {
  id: string;
  name: string;
  code: string;
  color: string | null;
  total: { scored: number; max: number };
  pct: number | null;
  grade: string;
}

export interface StudentMarksheetData {
  academicYear: string;
  subjects: MarksheetSubjectData[];
  grandTotal: { scored: number; max: number };
  grandPct: number | null;
  grade: string;
  classRank: number | null;
  classSize: number;
}

export async function getStudentMarksheetData(
  divisionId: string,
  studentId: string,
  institutionId: string
): Promise<StudentMarksheetData | null> {
  const division = await academicDb().division.findFirst({
    where: { id: divisionId, institutionId },
    select: { standardId: true },
  });
  if (!division) return null;

  const marksheet = await academicDb().marksheet.findFirst({
    where: { divisionId, institutionId, status: "PUBLISHED" },
    orderBy: { academicYear: "desc" },
    select: { id: true, academicYear: true, gradeScale: true },
  });
  if (!marksheet) return null;

  const gradeScale = (marksheet.gradeScale ?? []) as GradeScaleEntry[];

  const [subjects, examColumns, scores] = await Promise.all([
    academicDb().subject.findMany({
      where: { standardId: division.standardId, institutionId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, code: true, color: true },
    }),
    academicDb().marksheetExamColumn.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      orderBy: [{ subjectId: "asc" }, { order: "asc" }],
      select: { id: true, subjectId: true, name: true, maxMarks: true },
    }),
    academicDb().marksheetScore.findMany({
      where: { marksheetId: marksheet.id, institutionId, studentId },
      select: { examColumnId: true, score: true, isAbsent: true },
    }),
  ]);

  const scoreByCol = new Map(scores.map((s) => [s.examColumnId, s]));
  const colsBySubject: Record<string, typeof examColumns> = {};
  for (const c of examColumns) (colsBySubject[c.subjectId] ??= []).push(c);

  let grandScored = 0;
  let grandMax = 0;
  const subjectResults: MarksheetSubjectData[] = subjects.map((sub) => {
    const cols = colsBySubject[sub.id] ?? [];
    let scored = 0;
    let max = 0;
    for (const c of cols) {
      const e = scoreByCol.get(c.id);
      const sc = e?.score ?? null;
      const absent = e?.isAbsent ?? false;
      if (sc !== null) { scored += sc; max += c.maxMarks; }
      else if (!absent) { max += c.maxMarks; }
    }
    grandScored += scored;
    grandMax += max;
    const pct = max > 0 ? Math.round((scored / max) * 100) : null;
    return { id: sub.id, name: sub.name, code: sub.code ?? sub.name.slice(0, 4), color: sub.color ?? null, total: { scored, max }, pct, grade: gradeFor(pct, gradeScale) };
  });
  const grandPct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;

  const [allMarksheetScores, classSize] = await Promise.all([
    academicDb().marksheetScore.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      select: { studentId: true, score: true, isAbsent: true },
    }),
    academicDb().student.count({
      where: { divisionId, institutionId, status: "ACTIVE" },
    }),
  ]);
  const studentTotals = new Map<string, number>();
  for (const sc of allMarksheetScores) {
    if (!sc.isAbsent && sc.score !== null) {
      studentTotals.set(sc.studentId, (studentTotals.get(sc.studentId) ?? 0) + sc.score);
    }
  }
  const studentsAboveMe = [...studentTotals.values()].filter((t) => t > grandScored).length;
  const classRank = studentsAboveMe + 1;

  return {
    academicYear: marksheet.academicYear,
    subjects: subjectResults,
    grandTotal: { scored: grandScored, max: grandMax },
    grandPct,
    grade: gradeFor(grandPct, gradeScale),
    classRank,
    classSize,
  };
}
