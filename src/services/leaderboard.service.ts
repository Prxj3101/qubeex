import { academicDb } from "../utils/academicContext";
import { resolveUsers } from "./userLookup.service";

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

  const combinedMap = new Map<string, number>();
  const offlineMap = new Map<string, number>();
  const onlineMap = new Map<string, number>();
  let combinedMax = 0;
  let offlineMax = 0;
  let onlineMax = 0;

  if (marksheet) {
    const columns = await academicDb().marksheetExamColumn.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      select: { id: true, name: true, maxMarks: true },
    });
    const isOnlineCol = (name: string) => name.toLowerCase().includes("online");
    const colOnlineMap = new Map(columns.map((c) => [c.id, isOnlineCol(c.name)]));

    for (const c of columns) {
      combinedMax += c.maxMarks;
      if (colOnlineMap.get(c.id)) onlineMax += c.maxMarks;
      else offlineMax += c.maxMarks;
    }

    const allScores = await academicDb().marksheetScore.findMany({
      where: { marksheetId: marksheet.id, institutionId },
      select: { studentId: true, examColumnId: true, score: true, isAbsent: true },
    });

    for (const s of allScores) {
      if (s.isAbsent || s.score === null) continue;
      combinedMap.set(s.studentId, (combinedMap.get(s.studentId) ?? 0) + s.score);
      if (colOnlineMap.get(s.examColumnId)) {
        onlineMap.set(s.studentId, (onlineMap.get(s.studentId) ?? 0) + s.score);
      } else {
        offlineMap.set(s.studentId, (offlineMap.get(s.studentId) ?? 0) + s.score);
      }
    }
  }

  const users = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });

  const ranked = students
    .map((s) => {
      const att = attMap.get(s.id);
      const combinedScored = combinedMap.get(s.id) ?? 0;
      const offlineScored = offlineMap.get(s.id);
      const onlineScored = onlineMap.get(s.id);
      return {
        id: s.id,
        name: users.get(s.userId)?.name ?? "—",
        rollNo: s.rollNo ?? "",
        avatarUrl: s.avatarUrl,
        attendancePct: att && att.total > 0 ? Math.round((att.p / att.total) * 100) : null,
        combinedPct: combinedMax > 0 ? Math.round((combinedScored / combinedMax) * 100) : 0,
        offlinePct: offlineScored !== undefined && offlineMax > 0 ? Math.round((offlineScored / offlineMax) * 100) : null,
        onlinePct: onlineScored !== undefined && onlineMax > 0 ? Math.round((onlineScored / onlineMax) * 100) : null,
      };
    })
    .sort((a, b) => b.combinedPct - a.combinedPct);

  return ranked.map((s, i) => ({ ...s, rank: i + 1 }));
}
