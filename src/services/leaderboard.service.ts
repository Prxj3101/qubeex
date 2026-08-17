import { academicDb } from "../utils/academicContext";
import { resolveUsers } from "./userLookup.service";
import { computeOnlineMarksheet } from "./onlineMarksheet.service";

export interface LeaderboardEntry {
  id: string;
  name: string;
  rollNo: string;
  avatarUrl: string | null;
  attendancePct: number | null;
  combinedPct: number;
  offlinePct: number | null;
  onlinePct: number | null;
  rank: number;
}

export async function getDivisionLeaderboardData(
  divisionId: string,
  institutionId: string
): Promise<LeaderboardEntry[]> {
  const [students, marksheet] = await Promise.all([
    academicDb().student.findMany({
      where: { divisionId, institutionId, status: "ACTIVE" },
      select: { id: true, rollNo: true, avatarUrl: true, userId: true },
    }),
    academicDb().marksheet.findFirst({
      where: { divisionId, institutionId, status: "PUBLISHED" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    }),
  ]);

  const attendanceRecords = await academicDb().attendance.findMany({
    where: { divisionId, institutionId },
    select: { studentId: true, status: true },
  });
  // Same "% = (P + L) / Total" formula the attendance sheet itself uses —
  // Late still counts as attended. Counting only "P" here (as this used to)
  // undercounted anyone with Late marks, which is why this leaderboard's
  // attendance % never matched the real cumulative % shown on the
  // attendance tab / student profile for the same student.
  const attMap = new Map<string, { pl: number; total: number }>();
  for (const r of attendanceRecords) {
    const cur = attMap.get(r.studentId) ?? { pl: 0, total: 0 };
    cur.total++;
    if (r.status === "P" || r.status === "L") cur.pl++;
    attMap.set(r.studentId, cur);
  }

  const offlineMap = new Map<string, number>();
  // Per-student entered max — NOT a single class-wide max. A freshly added
  // exam column with no marks filled in yet must not drag down everyone's %:
  // the marksheet grid itself only divides by the columns a student actually
  // has a score for (see MarksTab's getSubjectTotal/enteredTotal), so this
  // mirrors that exactly instead of dividing by every column's maxMarks
  // regardless of whether it's been graded.
  const offlineMaxMap = new Map<string, number>();
  const onlineMap = new Map<string, number>();
  let onlineMax = 0;

  // Offline: the teacher-entered marksheet (published only — same "publish
  // before it counts" rule the marksheet itself follows).
  if (marksheet) {
    const columns = await academicDb().marksheetExamColumn.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      select: { id: true, maxMarks: true },
    });
    const maxByCol = new Map(columns.map((c) => [c.id, c.maxMarks]));

    const allScores = await academicDb().marksheetScore.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      select: { studentId: true, examColumnId: true, score: true, isAbsent: true },
    });
    for (const s of allScores) {
      if (s.isAbsent || s.score === null) continue;
      offlineMap.set(s.studentId, (offlineMap.get(s.studentId) ?? 0) + s.score);
      const colMax = maxByCol.get(s.examColumnId) ?? 0;
      offlineMaxMap.set(s.studentId, (offlineMaxMap.get(s.studentId) ?? 0) + colMax);
    }
  }

  // Online: auto-computed live from completed tests + attempts, same source
  // the online marksheet tab reads from — no separate publish step, no
  // guessing which offline column was secretly "the online one".
  const online = await computeOnlineMarksheet(divisionId, institutionId, null);
  for (const cols of Object.values(online.examColumns)) {
    for (const c of cols) onlineMax += c.maxMarks;
  }
  for (const studentScores of Object.values(online.scores)) {
    for (const [studentId, entry] of Object.entries(studentScores)) {
      if (entry.isAbsent || entry.score === null) continue;
      onlineMap.set(studentId, (onlineMap.get(studentId) ?? 0) + entry.score);
    }
  }

  const users = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });

  const ranked = students
    .map((s) => {
      const att = attMap.get(s.id);
      const offlineScored = offlineMap.get(s.id);
      const offlineMaxForStudent = offlineMaxMap.get(s.id) ?? 0;
      const onlineScored = onlineMap.get(s.id);
      const combinedScored = (offlineScored ?? 0) + (onlineScored ?? 0);
      // Per-student combined max: their own entered offline columns + the
      // (always fully "entered") online max — not a class-wide constant, so
      // an empty exam column doesn't drag down students who haven't been
      // graded on it yet, matching the offline marksheet's own math exactly.
      const combinedMaxForStudent = offlineMaxForStudent + onlineMax;
      return {
        id: s.id,
        name: users.get(s.userId)?.name ?? "—",
        rollNo: s.rollNo ?? "",
        avatarUrl: s.avatarUrl,
        attendancePct: att && att.total > 0 ? Math.round((att.pl / att.total) * 100) : null,
        combinedPct: combinedMaxForStudent > 0 ? Math.round((combinedScored / combinedMaxForStudent) * 100) : 0,
        // Offline: no entry yet reads as unknown (dash), same as the marksheet
        // grid. Online: tests are already completed, so a student with zero
        // recorded attempts still gets a real 0%, not a dash — same "missed
        // means 0" rule as the online marksheet cells.
        offlinePct: offlineScored !== undefined && offlineMaxForStudent > 0 ? Math.round((offlineScored / offlineMaxForStudent) * 100) : null,
        onlinePct: onlineMax > 0 ? Math.round(((onlineScored ?? 0) / onlineMax) * 100) : null,
      };
    })
    .sort((a, b) => b.combinedPct - a.combinedPct);

  return ranked.map((s, i) => ({ ...s, rank: i + 1 }));
}
