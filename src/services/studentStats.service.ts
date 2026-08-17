import { academicDb } from "../utils/academicContext";
import { computeOnlineMarksheet } from "./onlineMarksheet.service";

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
  const attendanceRecords = await academicDb().attendance.findMany({
    where: { studentId, divisionId, institutionId },
    select: { status: true },
  });
  const attendanceTotal = attendanceRecords.length;
  const attendancePresent = attendanceRecords.filter((r) => r.status === "P").length;
  // Same "% = (P + L) / Total" formula the attendance sheet itself uses —
  // Late still counts as attended. `present` stays P-only (it's a literal
  // count shown alongside Total elsewhere), but the % must include Late or
  // it silently disagrees with the cumulative % shown on the attendance tab.
  const attendancePL = attendanceRecords.filter((r) => r.status === "P" || r.status === "L").length;
  const attendancePct = attendanceTotal > 0
    ? Math.round((attendancePL / attendanceTotal) * 100)
    : null;

  const [marksheet, division] = await Promise.all([
    academicDb().marksheet.findFirst({
      where: { divisionId, institutionId, status: "PUBLISHED" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        examColumns: { select: { id: true, subjectId: true, maxMarks: true } },
      },
    }),
    academicDb().division.findFirst({
      where: { id: divisionId, institutionId },
      select: { standardId: true },
    }),
  ]);

  let scorePct: number | null = null;
  let classRank: number | null = null;
  const subjects: SubjectPerf[] = [];

  // Online: auto-computed live from completed tests + attempts — same source
  // the online marksheet tab and leaderboard read from, best attempt per
  // student per test. No separate publish step of its own.
  const online = await computeOnlineMarksheet(divisionId, institutionId, null);
  let onlineMax = 0;
  for (const cols of Object.values(online.examColumns)) {
    for (const c of cols) onlineMax += c.maxMarks;
  }
  const onlineTotals = new Map<string, number>();
  for (const studentScores of Object.values(online.scores)) {
    for (const [sid, entry] of Object.entries(studentScores)) {
      if (entry.isAbsent || entry.score === null) continue;
      onlineTotals.set(sid, (onlineTotals.get(sid) ?? 0) + entry.score);
    }
  }

  if (marksheet) {
    const columnIds = marksheet.examColumns.map((c) => c.id);

    if (columnIds.length > 0) {
      const [allScores, studentScores] = await Promise.all([
        academicDb().marksheetScore.findMany({
          where: { marksheetId: marksheet.id, institutionId },
          select: { studentId: true, examColumnId: true, score: true, isAbsent: true },
        }),
        academicDb().marksheetScore.findMany({
          where: { marksheetId: marksheet.id, institutionId, studentId },
          select: { examColumnId: true, score: true, isAbsent: true },
        }),
      ]);

      const maxByCol = new Map(marksheet.examColumns.map((c) => [c.id, c.maxMarks]));

      // Per-student entered max, NOT a class-wide constant — a freshly added
      // exam column with no marks filled in yet must not drag down anyone's
      // %, same as the marksheet grid's own getSubjectTotal/enteredTotal
      // math (only columns a student actually has a score for count toward
      // their denominator).
      const offlineTotals = new Map<string, number>();
      const offlineMaxByStudent = new Map<string, number>();
      for (const s of allScores) {
        if (s.isAbsent || s.score === null) continue;
        offlineTotals.set(s.studentId, (offlineTotals.get(s.studentId) ?? 0) + s.score);
        const colMax = maxByCol.get(s.examColumnId) ?? 0;
        offlineMaxByStudent.set(s.studentId, (offlineMaxByStudent.get(s.studentId) ?? 0) + colMax);
      }

      // Combined (offline + online) weighted totals, same "pooled scored /
      // pooled max" rule used by the leaderboard and Overall tab — not a
      // naive average of two percentages. Ranking below is by raw total
      // marks (not %), so a shared/varying max per student doesn't skew it.
      const studentOfflineMax = offlineMaxByStudent.get(studentId) ?? 0;
      const combinedMax = studentOfflineMax + onlineMax;
      const allStudentIds = new Set([...offlineTotals.keys(), ...onlineTotals.keys(), studentId]);
      const combinedTotals = new Map<string, number>();
      for (const sid of allStudentIds) {
        combinedTotals.set(sid, (offlineTotals.get(sid) ?? 0) + (onlineTotals.get(sid) ?? 0));
      }

      const studentCombinedTotal = combinedTotals.get(studentId) ?? 0;
      const hasAnyScore = offlineTotals.has(studentId) || onlineTotals.has(studentId);
      if (hasAnyScore && combinedMax > 0) {
        scorePct = Math.round((studentCombinedTotal / combinedMax) * 100);
        const higher = [...combinedTotals.values()].filter((t) => t > studentCombinedTotal).length;
        classRank = higher + 1;
      }

      if (division) {
        const subjectRows = await academicDb().subject.findMany({
          where: { standardId: division.standardId, institutionId },
          orderBy: { order: "asc" },
          select: { id: true, name: true, code: true, color: true },
        });
        const scoreByCol = new Map(studentScores.map((s) => [s.examColumnId, s]));
        for (const sub of subjectRows) {
          const cols = marksheet.examColumns.filter((c) => c.subjectId === sub.id);
          if (cols.length === 0) continue;
          // Matches the marksheet grid's own enteredTotal rule exactly: a
          // column only counts toward max if this student has a real
          // (non-null) score in it. Blank AND absent both mean "not
          // entered" here — neither should inflate or shrink the max.
          let scored = 0, max = 0;
          for (const col of cols) {
            const e = scoreByCol.get(col.id);
            if (e?.score != null) { scored += e.score; max += col.maxMarks; }
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
  } else if (onlineMax > 0) {
    // No offline marksheet published yet, but online tests exist — combined
    // score should still reflect online-only performance, not stay blank.
    const higher = [...onlineTotals.values()].filter((t) => t > (onlineTotals.get(studentId) ?? 0)).length;
    if (onlineTotals.has(studentId)) {
      scorePct = Math.round(((onlineTotals.get(studentId) ?? 0) / onlineMax) * 100);
      classRank = higher + 1;
    }
  }

  return {
    attendance: { present: attendancePresent, total: attendanceTotal, pct: attendancePct },
    score: { pct: scorePct },
    classRank,
    subjects,
  };
}
