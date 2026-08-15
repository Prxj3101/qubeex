import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { computeOnlineMarksheet } from "../../services/onlineMarksheet.service";

// ── GET /api/admin/marksheet ──────────────────────────────────────────────────

export async function adminListMarksheets(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }

    const { divisionId, standardId, academicYear } = req.query as {
      divisionId?: string;
      standardId?: string;
      academicYear?: string;
    };

    const marksheets = await academicDb().marksheet.findMany({
      where: {
        institutionId,
        ...(divisionId && { divisionId }),
        ...(standardId && { division: { standardId } }),
        ...(academicYear && { academicYear }),
      },
      include: {
        division: { include: { standard: true } },
        createdBy: { select: { userId: true } },
        _count: { select: { examColumns: true, scores: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Creator names are central (Teacher/Marksheet may be in a tenant DB, BYOD).
    const createdByUsers = await resolveUsers(marksheets.map((m) => m.createdBy.userId), { id: true, name: true });

    res.json({
      success: true,
      data: marksheets.map((m) => ({
        id: m.id,
        academicYear: m.academicYear,
        status: m.status,
        shareToken: m.shareToken,
        divisionId: m.divisionId,
        divisionName: m.division.name,
        standardName: m.division.standard.name,
        createdByName: createdByUsers.get(m.createdBy.userId)?.name ?? null,
        examColumnCount: m._count.examColumns,
        scoreCount: m._count.scores,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/admin/marksheet/division/:divisionId ─────────────────────────────

export async function adminGetDivisionMarksheet(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;
    const academicYear = (req.query.academicYear as string) || getCurrentAcademicYear();

    const marksheet = await academicDb().marksheet.findUnique({
      where: { divisionId_academicYear: { divisionId, academicYear } },
      select: { id: true, institutionId: true },
    });
    if (!marksheet || marksheet.institutionId !== institutionId) {
      res.status(404).json({ success: false, error: "Marksheet not found" });
      return;
    }

    const [ms, examColumns, scores, gradedSubjects, gradedScores, remarks, students] = await Promise.all([
      academicDb().marksheet.findUnique({
        where: { id: marksheet.id },
        select: {
          id: true, academicYear: true, status: true, shareToken: true, gradedSectionTitle: true, gradeScale: true,
          subjectConfigs: { select: { subjectId: true, passingMarks: true, gradeScale: true } },
        },
      }),
      academicDb().marksheetExamColumn.findMany({
        where: { marksheetId: marksheet.id, institutionId },
        orderBy: [{ subjectId: "asc" }, { order: "asc" }],
        select: { id: true, subjectId: true, name: true, maxMarks: true, examDate: true, order: true },
      }),
      academicDb().marksheetScore.findMany({
        where: { marksheetId: marksheet.id },
        select: { examColumnId: true, studentId: true, score: true, isAbsent: true },
      }),
      academicDb().marksheetGradedSubject.findMany({
        where: { marksheetId: marksheet.id },
        orderBy: { order: "asc" },
        select: { id: true, name: true, order: true },
      }),
      academicDb().marksheetGradedScore.findMany({
        where: { marksheetId: marksheet.id },
        select: { gradedSubjectId: true, studentId: true, term1Grade: true, term2Grade: true },
      }),
      academicDb().marksheetRemark.findMany({
        where: { marksheetId: marksheet.id },
        select: { studentId: true, conduct: true, remarks: true },
      }),
      academicDb().student.findMany({
        where: { divisionId, institutionId },
        orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
      }),
    ]);
    const detailStudentUsers = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });
    const signedAvatarMap = await generateSignedAvatarUrlsBatch(students.map((s) => s.avatarUrl));

    const columnsBySubject: Record<string, typeof examColumns> = {};
    for (const col of examColumns) {
      if (!columnsBySubject[col.subjectId]) columnsBySubject[col.subjectId] = [];
      columnsBySubject[col.subjectId].push(col);
    }

    const scoreMap: Record<string, Record<string, { score: number | null; isAbsent: boolean }>> = {};
    for (const sc of scores) {
      if (!scoreMap[sc.examColumnId]) scoreMap[sc.examColumnId] = {};
      scoreMap[sc.examColumnId][sc.studentId] = { score: sc.score, isAbsent: sc.isAbsent };
    }

    const gradedScoreMap: Record<string, Record<string, { term1Grade: string | null; term2Grade: string | null }>> = {};
    for (const gs of gradedScores) {
      if (!gradedScoreMap[gs.gradedSubjectId]) gradedScoreMap[gs.gradedSubjectId] = {};
      gradedScoreMap[gs.gradedSubjectId][gs.studentId] = { term1Grade: gs.term1Grade, term2Grade: gs.term2Grade };
    }

    // Admin sees remarks read-only, same as it sees everything else here —
    // only the class teacher can write them (via the teacher route).
    const remarksMap: Record<string, { conduct: string | null; remarks: string | null }> = {};
    for (const r of remarks) {
      remarksMap[r.studentId] = { conduct: r.conduct, remarks: r.remarks };
    }

    res.json({
      success: true,
      data: {
        marksheet: {
          id: ms!.id, academicYear: ms!.academicYear, status: ms!.status,
          shareToken: ms!.shareToken, gradedSectionTitle: ms!.gradedSectionTitle,
        },
        gradeScale: (ms!.gradeScale ?? []) as { grade: string; minPct: number }[],
        subjectConfigs: ms!.subjectConfigs,
        examColumns: columnsBySubject,
        scores: scoreMap,
        gradedSubjects,
        gradedScores: gradedScoreMap,
        remarks: remarksMap,
        students: students.map((s) => ({
          id: s.id,
          name: detailStudentUsers.get(s.userId)?.name ?? null,
          rollNo: s.rollNo ?? "",
          avatarUrl: s.avatarUrl ? (signedAvatarMap[s.avatarUrl] ?? s.avatarUrl) : null,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/admin/campus/divisions/:divisionId/class-teacher ───────────────

export async function assignClassTeacher(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;
    const bodySchema = z.object({ teacherId: z.string().uuid().nullable() });
    const parseResult = bodySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ success: false, error: "teacherId must be a UUID or null" });
      return;
    }
    const { teacherId } = parseResult.data;

    const division = await academicDb().division.findFirst({
      where: { id: divisionId, institutionId },
      select: { id: true },
    });
    if (!division) { res.status(404).json({ success: false, error: "Division not found" }); return; }

    if (teacherId !== null) {
      const teacher = await academicDb().teacher.findFirst({
        where: { id: teacherId, institutionId },
        select: { id: true },
      });
      if (!teacher) { res.status(404).json({ success: false, error: "Teacher not found" }); return; }

      // A teacher can be class teacher (null subjectId) of at most one division —
      // reject if they're already the class teacher elsewhere.
      const existingClassTeacherDivision = await academicDb().division.findFirst({
        where: { institutionId, classTeacherId: teacherId, id: { not: divisionId } },
        select: { name: true, standard: { select: { name: true } } },
      });
      if (existingClassTeacherDivision) {
        res.status(409).json({
          success: false,
          error: `Teacher is already class teacher of ${existingClassTeacherDivision.standard.name} - ${existingClassTeacherDivision.name}`,
        });
        return;
      }
    }

    await academicDb().$transaction(async (tx) => {
      await tx.division.update({
        where: { id: divisionId },
        data: { classTeacherId: teacherId ?? null },
      });

      // Keep DivisionAssignment (the class-teacher slot: subjectId = null) in
      // sync with the denormalized Division.classTeacherId field.
      const existingSlot = await tx.divisionAssignment.findFirst({
        where: { divisionId, subjectId: null },
      });

      if (teacherId === null) {
        if (existingSlot) await tx.divisionAssignment.delete({ where: { id: existingSlot.id } });
      } else if (existingSlot) {
        await tx.divisionAssignment.update({ where: { id: existingSlot.id }, data: { teacherId } });
      } else {
        await tx.divisionAssignment.create({
          data: { divisionId, institutionId, teacherId, subjectId: null },
        });
      }
    });

    res.json({ success: true, data: { divisionId, classTeacherId: teacherId ?? null } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/admin/marksheet/division/:divisionId/online ───────────────────────
// Admin always sees every subject in the division — no per-subject restriction.
export async function adminGetDivisionOnlineMarksheet(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
    const divisionId = req.params.divisionId as string;

    const division = await academicDb().division.findFirst({
      where: { id: divisionId, institutionId },
      select: { id: true },
    });
    if (!division) { res.status(404).json({ success: false, error: "Division not found" }); return; }

    const data = await computeOnlineMarksheet(divisionId, institutionId, null);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

function getCurrentAcademicYear(): string {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const startYear = month >= 5 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}
