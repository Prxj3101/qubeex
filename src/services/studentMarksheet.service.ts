import { academicDb } from "../utils/academicContext";
import { resolveGrade, GradeScaleEntry } from "./gradeScale";
import { computeOnlineMarksheet } from "./onlineMarksheet.service";

function gradeFor(pct: number | null, scale: GradeScaleEntry[]): string {
  if (pct === null) return "—";
  return resolveGrade(pct, scale);
}

export interface OnlineTestColumn {
  id: string;
  name: string;
  maxMarks: number;
  score: number | null;
  isAbsent: boolean;
}

export interface MarksheetSubjectData {
  id: string;
  name: string;
  code: string;
  color: string | null;
  total: { scored: number; max: number };
  pct: number | null;
  grade: string;
  // Online (auto-fed from completed tests) — same live-computed source the
  // online marksheet tab and leaderboard read from, no publish step of its
  // own. Added so the teacher/admin "View Profile" Subject Performance graph
  // and Report Card's Online tab show real data instead of nothing.
  onlineTotal: { scored: number; max: number };
  onlinePct: number | null;
  onlineGrade: string;
  // Per-test breakdown (which tests, what mark each) — mirrors the student's
  // own /student/marksheet route's onlineColumns so the teacher/admin report
  // card's Online tab can show the actual per-test grid instead of just an
  // aggregate total + test count.
  onlineColumns: OnlineTestColumn[];
}

export interface GradedSubjectData {
  id: string;
  name: string;
  term1Grade: string | null;
  term2Grade: string | null;
}

export interface StudentMarksheetData {
  academicYear: string;
  gradeScale: GradeScaleEntry[];
  subjects: MarksheetSubjectData[];
  grandTotal: { scored: number; max: number };
  grandPct: number | null;
  grade: string;
  onlineGrandTotal: { scored: number; max: number };
  onlineGrandPct: number | null;
  onlineGrade: string;
  combinedGrandTotal: { scored: number; max: number };
  combinedGrandPct: number | null;
  combinedGrade: string;
  classRank: number | null;
  offlineClassRank: number | null;
  onlineClassRank: number | null;
  combinedClassRank: number | null;
  classSize: number;
  // Same "Graded Subjects" section (qualitative term grades, not scored) plus
  // Conduct/Remarks the student's own report card shows — added so the
  // teacher/admin "View Report Card" page for a student matches it exactly
  // instead of silently dropping this section.
  gradedSubjects: GradedSubjectData[];
  conduct: string | null;
  remarks: string | null;
}

// Shared by the teacher's and admin's "View Profile" Subject Performance
// graph and the Report Card page (both read the same
// /classes/:divisionId/students/:studentId/marksheet endpoint). Mirrors
// student.routes.ts's own GET /student/marksheet computation — same
// published-snapshot preference, same online-marks source, same
// offline/online/combined class-rank math — so a teacher/admin looking at a
// student's profile sees exactly the same numbers that student sees on their
// own dashboard, instead of an offline-only, non-snapshotted approximation.
export async function getStudentMarksheetData(
  divisionId: string,
  studentId: string,
  institutionId: string
): Promise<StudentMarksheetData | null> {
  const division = await academicDb().division.findFirst({
    where: { id: divisionId, institutionId },
    select: { id: true, standardId: true },
  });
  if (!division) return null;

  const marksheet = await academicDb().marksheet.findFirst({
    where: { divisionId, institutionId, status: "PUBLISHED" },
    orderBy: { academicYear: { label: "desc" } },
    select: { id: true, academicYear: { select: { label: true } }, gradeScale: true, publishedSnapshot: true },
  });
  if (!marksheet) return null;

  // Prefer the frozen publish-time snapshot (score edits the teacher hasn't
  // re-published yet stay invisible here, same as the student's own view).
  // Marksheets published before this feature existed have no snapshot —
  // fall back to live tables for those.
  const snap = marksheet.publishedSnapshot as {
    gradeScale?: GradeScaleEntry[];
    examColumns: { id: string; subjectId: string; name: string; maxMarks: number; order?: number }[];
    scores: { studentId: string; examColumnId: string; score: number | null; isAbsent: boolean }[];
    gradedSubjects: { id: string; name: string }[];
    gradedScores: { gradedSubjectId: string; studentId: string; term1Grade: string | null; term2Grade: string | null }[];
    remarks: { studentId: string; conduct: string | null; remarks: string | null }[];
  } | null;

  const gradeScale = (snap?.gradeScale ?? marksheet.gradeScale ?? []) as GradeScaleEntry[];

  const [subjects, examColumns, scores, gradedSubjectsRaw, gradedScoresRaw, remark] = snap
    ? await Promise.all([
        academicDb().subject.findMany({
          where: { standardId: division.standardId, institutionId },
          orderBy: { order: "asc" },
          select: { id: true, name: true, code: true, color: true },
        }),
        // The snapshot's own array order isn't guaranteed to match the
        // teacher's actual drag-reorder/add sequence (publishMarksheet's
        // capture query has no orderBy) — sort by the stored `order` field
        // explicitly, same as the live-table query below already does via
        // `orderBy: [{ subjectId: "asc" }, { order: "asc" }]`.
        Promise.resolve([...snap.examColumns].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
        Promise.resolve(snap.scores.filter((s) => s.studentId === studentId)),
        Promise.resolve(snap.gradedSubjects ?? []),
        Promise.resolve((snap.gradedScores ?? []).filter((g) => g.studentId === studentId)),
        Promise.resolve((snap.remarks ?? []).find((r) => r.studentId === studentId) ?? null),
      ])
    : await Promise.all([
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
        academicDb().marksheetGradedSubject.findMany({
          where: { marksheetId: marksheet.id, institutionId },
          orderBy: { order: "asc" },
          select: { id: true, name: true },
        }),
        academicDb().marksheetGradedScore.findMany({
          where: { marksheetId: marksheet.id, institutionId, studentId },
          select: { gradedSubjectId: true, term1Grade: true, term2Grade: true },
        }),
        academicDb().marksheetRemark.findFirst({
          where: { marksheetId: marksheet.id, institutionId, studentId },
          select: { conduct: true, remarks: true },
        }),
      ]);

  const gradeByGs = new Map(gradedScoresRaw.map((g) => [g.gradedSubjectId, g]));
  const gradedSubjects: GradedSubjectData[] = gradedSubjectsRaw.map((gs) => {
    const g = gradeByGs.get(gs.id);
    return { id: gs.id, name: gs.name, term1Grade: g?.term1Grade ?? null, term2Grade: g?.term2Grade ?? null };
  });

  const scoreByCol = new Map(scores.map((s) => [s.examColumnId, s]));
  const colsBySubject: Record<string, typeof examColumns> = {};
  for (const c of examColumns) (colsBySubject[c.subjectId] ??= []).push(c);

  // Online: same live-computed source the online marksheet tab and
  // leaderboard read from — no publish step of its own, always current.
  const online = await computeOnlineMarksheet(divisionId, institutionId, null);

  let grandScored = 0;
  let grandMax = 0;
  let onlineGrandScored = 0;
  let onlineGrandMax = 0;
  const subjectResults: MarksheetSubjectData[] = subjects.map((sub) => {
    const cols = colsBySubject[sub.id] ?? [];
    let scored = 0;
    let max = 0;
    for (const c of cols) {
      const e = scoreByCol.get(c.id);
      const sc = e?.score ?? null;
      // Matches the student's own /student/marksheet route's rule exactly: a
      // column only counts toward max if this student has a real (non-null)
      // score in it — blank AND absent both mean "not entered" here. The
      // previous extra `else if (!absent)` branch counted still-ungraded
      // columns toward the denominator anyway, artificially dragging this
      // %  below what the student's own dashboard showed for the same data.
      if (sc !== null) { scored += sc; max += c.maxMarks; }
    }
    grandScored += scored;
    grandMax += max;
    const pct = max > 0 ? Math.round((scored / max) * 100) : null;

    // Online: the test is already completed by the time it shows up here, so
    // a missing attempt means the student missed it — a hard 0, not an
    // unknown/blank value (unlike offline, where no entry = not graded yet).
    const onlineCols = online.examColumns[sub.id] ?? [];
    let onlineScored = 0;
    let onlineMax = 0;
    const onlineColumns: OnlineTestColumn[] = onlineCols.map((c) => {
      const e = online.scores[c.id]?.[studentId];
      // The test is already completed by the time it shows up here, so a
      // missing attempt means the student missed it — a hard 0, not an
      // unknown/blank value (unlike offline, where no entry = not graded yet).
      const isAbsent = e?.isAbsent ?? false;
      const sc = isAbsent ? null : (e?.score ?? 0);
      if (!isAbsent) { onlineMax += c.maxMarks; if (sc !== null) onlineScored += sc; }
      return { id: c.id, name: c.name, maxMarks: c.maxMarks, score: sc, isAbsent };
    });
    onlineGrandScored += onlineScored;
    onlineGrandMax += onlineMax;
    const onlinePct = onlineMax > 0 ? Math.round((onlineScored / onlineMax) * 100) : null;

    return {
      id: sub.id, name: sub.name, code: sub.code ?? sub.name.slice(0, 4), color: sub.color ?? null,
      total: { scored, max }, pct, grade: gradeFor(pct, gradeScale),
      onlineTotal: { scored: onlineScored, max: onlineMax }, onlinePct, onlineGrade: gradeFor(onlinePct, gradeScale),
      onlineColumns,
    };
  });
  const grandPct = grandMax > 0 ? Math.round((grandScored / grandMax) * 100) : null;
  const onlineGrandPct = onlineGrandMax > 0 ? Math.round((onlineGrandScored / onlineGrandMax) * 100) : null;
  // Combined = offline + online pooled into one scored/max ratio (matches
  // the student's own /student/marksheet route and StudentProfileView).
  const combinedGrandMax = grandMax + onlineGrandMax;
  const combinedGrandScored = grandScored + onlineGrandScored;
  const combinedGrandPct = combinedGrandMax > 0 ? Math.round((combinedGrandScored / combinedGrandMax) * 100) : null;

  const [allMarksheetScores, classSize] = await Promise.all([
    snap
      ? Promise.resolve(snap.scores)
      : academicDb().marksheetScore.findMany({
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

  // Online + combined rank, same "compare raw totals" approach as offline —
  // ranking by raw scored totals rather than %, so per-student differences in
  // entered max don't need to be normalized out here.
  const onlineStudentTotals = new Map<string, number>();
  for (const studentScores of Object.values(online.scores)) {
    for (const [sid, entry] of Object.entries(studentScores)) {
      if (entry.isAbsent || entry.score === null) continue;
      onlineStudentTotals.set(sid, (onlineStudentTotals.get(sid) ?? 0) + entry.score);
    }
  }
  const onlineAboveMe = [...onlineStudentTotals.values()].filter((t) => t > onlineGrandScored).length;
  const onlineClassRank = onlineGrandMax > 0 ? onlineAboveMe + 1 : null;

  const allRankedIds = new Set([...studentTotals.keys(), ...onlineStudentTotals.keys(), studentId]);
  const combinedTotals = new Map<string, number>();
  for (const sid of allRankedIds) {
    combinedTotals.set(sid, (studentTotals.get(sid) ?? 0) + (onlineStudentTotals.get(sid) ?? 0));
  }
  const myCombinedTotal = grandScored + onlineGrandScored;
  const combinedAboveMe = [...combinedTotals.values()].filter((t) => t > myCombinedTotal).length;
  const combinedClassRank = (grandMax + onlineGrandMax) > 0 ? combinedAboveMe + 1 : null;

  return {
    academicYear: marksheet.academicYear.label,
    gradeScale,
    subjects: subjectResults,
    grandTotal: { scored: grandScored, max: grandMax },
    grandPct,
    grade: gradeFor(grandPct, gradeScale),
    onlineGrandTotal: { scored: onlineGrandScored, max: onlineGrandMax },
    onlineGrandPct,
    onlineGrade: gradeFor(onlineGrandPct, gradeScale),
    combinedGrandTotal: { scored: combinedGrandScored, max: combinedGrandMax },
    combinedGrandPct,
    combinedGrade: gradeFor(combinedGrandPct, gradeScale),
    classRank,
    offlineClassRank: classRank,
    onlineClassRank,
    combinedClassRank,
    classSize,
    gradedSubjects,
    conduct: remark?.conduct ?? null,
    remarks: remark?.remarks ?? null,
  };
}
