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
  const attMap = new Map<string, { p: number; total: number }>();
  for (const r of attendanceRecords) {
    const cur = attMap.get(r.studentId) ?? { p: 0, total: 0 };
    cur.total++;
    if (r.status === "P") cur.p++;
    attMap.set(r.studentId, cur);
  }

  const offlineMap = new Map<string, number>();
  const onlineMap = new Map<string, number>();
  let offlineMax = 0;
  let onlineMax = 0;

  // Offline: the teacher-entered marksheet (published only — same "publish
  // before it counts" rule the marksheet itself follows).
  if (marksheet) {
    const columns = await academicDb().marksheetExamColumn.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      select: { id: true, maxMarks: true },
    });
    for (const c of columns) offlineMax += c.maxMarks;

    const allScores = await academicDb().marksheetScore.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      select: { studentId: true, score: true, isAbsent: true },
    });
    for (const s of allScores) {
      if (s.isAbsent || s.score === null) continue;
      offlineMap.set(s.studentId, (offlineMap.get(s.studentId) ?? 0) + s.score);
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

  const combinedMax = offlineMax + onlineMax;

  const users = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });

  const ranked = students
    .map((s) => {
      const att = attMap.get(s.id);
      const offlineScored = offlineMap.get(s.id);
      const onlineScored = onlineMap.get(s.id);
      const combinedScored = (offlineScored ?? 0) + (onlineScored ?? 0);
      return {
        id: s.id,
        name: users.get(s.userId)?.name ?? "—",
        rollNo: s.rollNo ?? "",
        avatarUrl: s.avatarUrl,
        attendancePct: att && att.total > 0 ? Math.round((att.p / att.total) * 100) : null,
        combinedPct: combinedMax > 0 ? Math.round((combinedScored / combinedMax) * 100) : 0,
        // Offline: no entry yet reads as unknown (dash), same as the marksheet
        // grid. Online: tests are already completed, so a student with zero
        // recorded attempts still gets a real 0%, not a dash — same "missed
        // means 0" rule as the online marksheet cells.
        offlinePct: offlineScored !== undefined && offlineMax > 0 ? Math.round((offlineScored / offlineMax) * 100) : null,
        onlinePct: onlineMax > 0 ? Math.round(((onlineScored ?? 0) / onlineMax) * 100) : null,
      };
    })
    .sort((a, b) => b.combinedPct - a.combinedPct);

  return ranked.map((s, i) => ({ ...s, rank: i + 1 }));
}
