// src/services/onlineMarksheet.service.ts
import { academicDb } from "../utils/academicContext";

export interface OnlineExamColumn {
  id: string;
  subjectId: string;
  name: string;
  maxMarks: number;
  examDate: string | null;
  order: number;
}

export interface OnlineMarksheetData {
  examColumns: Record<string, OnlineExamColumn[]>;
  scores: Record<string, Record<string, { score: number | null; isAbsent: boolean }>>;
}

// Computes the "online" marksheet live, straight from completed tests and
// their attempts — there is no persisted online-marksheet table to keep in
// sync, so this is always exactly up to date. A student's cell for a given
// test is their best (highest) score among all of their own completed
// attempts on it, matching the "highest attempt counts" rule used everywhere
// else a multi-attempt test's score is shown (test cards, results table).
// subjectIds null = no restriction (class teacher / admin see every subject
// in the division); otherwise limited to the given subject(s) — a subject
// teacher's own class card only shows their subject's tests.
export async function computeOnlineMarksheet(
  divisionId: string,
  institutionId: string,
  subjectIds: string[] | null
): Promise<OnlineMarksheetData> {
  const tests = await academicDb().taskTest.findMany({
    where: {
      divisionId,
      institutionId,
      status: "COMPLETED",
      ...(subjectIds ? { subjectId: { in: subjectIds } } : {}),
    },
    select: {
      id: true, title: true, totalMarks: true, subjectId: true,
      validUntil: true, startDate: true, createdAt: true,
    },
    orderBy: [{ validUntil: "asc" }, { createdAt: "asc" }],
  });

  const examColumns: Record<string, OnlineExamColumn[]> = {};
  const orderCounters: Record<string, number> = {};
  for (const t of tests) {
    if (!examColumns[t.subjectId]) examColumns[t.subjectId] = [];
    const order = orderCounters[t.subjectId] ?? 0;
    orderCounters[t.subjectId] = order + 1;
    examColumns[t.subjectId].push({
      id: t.id,
      subjectId: t.subjectId,
      name: t.title,
      maxMarks: t.totalMarks,
      examDate: (t.validUntil ?? t.startDate ?? t.createdAt)?.toISOString() ?? null,
      order,
    });
  }

  const scores: Record<string, Record<string, { score: number | null; isAbsent: boolean }>> = {};
  if (tests.length > 0) {
    const attempts = await academicDb().taskTestAttempt.findMany({
      where: { testId: { in: tests.map((t) => t.id) }, status: "completed" },
      select: { testId: true, studentId: true, totalScore: true },
    });
    for (const a of attempts) {
      // studentId is nullable (SetNull if the student's record is later
      // removed) — nothing to key a marksheet cell on in that case, skip.
      if (!a.studentId) continue;
      if (!scores[a.testId]) scores[a.testId] = {};
      const existing = scores[a.testId][a.studentId];
      if (!existing || a.totalScore > (existing.score ?? -Infinity)) {
        scores[a.testId][a.studentId] = { score: a.totalScore, isAbsent: false };
      }
    }
  }

  return { examColumns, scores };
}
