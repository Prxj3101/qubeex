import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { computeOnlineMarksheet } from "../../services/onlineMarksheet.service";
import { getCurrentAcademicYear as resolveCurrentAcademicYear } from "../../utils/academicYear";

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
        ...(academicYear && { academicYear: { label: academicYear } }),
      },
      include: {
        division: { include: { standard: true } },
        createdBy: { select: { userId: true } },
        _count: { select: { examColumns: true, scores: true } },
        academicYear: { select: { label: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Creator names are central (Teacher/Marksheet may be in a tenant DB, BYOD).
    const createdByUsers = await resolveUsers(marksheets.map((m) => m.createdBy.userId), { id: true, name: true });

    res.json({
      success: true,
      data: marksheets.map((m) => ({
        id: m.id,
        academicYear: m.academicYear.label,
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
    const academicYear = (req.query.academicYear as string) || defaultYearLabel();

    const marksheet = await academicDb().marksheet.findFirst({
      where: { divisionId, institutionId, academicYear: { label: academicYear } },
      select: { id: true, institutionId: true },
    });
    if (!marksheet || marksheet.institutionId !== institutionId) {
      res.status(404).json({ success: false, error: "Marksheet not found" });
      return;
    }

    // Read-only report-card VIEWS (admin "View Report Card" for a single
    // student) pass this so live, not-yet-republished score edits stay
    // invisible — same "frozen at publish time" guarantee the student's own
    // dashboard already gets. The score grid's normal use (viewing the whole
    // class live) keeps reading live tables, so this defaults to off.
    const publishedOnly = req.query.publishedOnly === "1";

    const [ms, examColumnsLive, scoresLive, gradedSubjectsLive, gradedScoresLive, remarksLive, students] = await Promise.all([
      academicDb().marksheet.findUnique({
        where: { id: marksheet.id },
        select: {
          id: true, academicYear: { select: { label: true } }, status: true, shareToken: true, gradedSectionTitle: true, gradeScale: true,
          hasUnpublishedChanges: true, publishedSnapshot: true,
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

    if (publishedOnly && ms?.status !== "PUBLISHED") {
      // Nothing frozen to show yet — caller (report-card view) falls back to
      // its own per-student summary source, same as "not published" elsewhere.
      res.status(404).json({ success: false, error: "Marksheet not published yet" });
      return;
    }

    const snap = publishedOnly
      ? (ms?.publishedSnapshot as {
          examColumns: { id: string; subjectId: string; name: string; maxMarks: number; examDate: string | null; order: number }[];
          scores: { studentId: string; examColumnId: string; score: number | null; isAbsent: boolean }[];
          gradedSubjects: { id: string; name: string; order: number }[];
          gradedScores: { gradedSubjectId: string; studentId: string; term1Grade: string | null; term2Grade: string | null }[];
          remarks: { studentId: string; conduct: string | null; remarks: string | null }[];
        } | null)
      : null;

    // publishedOnly with no snapshot at all (marksheet published before the
    // snapshot feature existed) — fall back to live tables rather than
    // showing nothing, same accommodation studentMarksheet.service.ts makes.
    // The snapshot's own array order isn't guaranteed to match the teacher's
    // actual drag-reorder/add sequence (publishMarksheet's capture query has
    // no orderBy) — sort by the stored `order` field explicitly, same as the
    // live-table queries above already do via `orderBy: [...,{order:"asc"}]`.
    const examColumns = snap ? [...snap.examColumns].sort((a, b) => a.order - b.order) : examColumnsLive;
    const scores = snap ? snap.scores : scoresLive;
    const gradedSubjects = snap ? [...snap.gradedSubjects].sort((a, b) => a.order - b.order) : gradedSubjectsLive;
    const gradedScores = snap ? snap.gradedScores : gradedScoresLive;
    const remarks = snap ? snap.remarks : remarksLive;

    const detailStudentUsers = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });
    const signedAvatarMap = await generateSignedAvatarUrlsBatch(students.map((s) => s.avatarUrl));

    const columnsBySubject: Record<string, (typeof examColumns)[number][]> = {};
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
          id: ms!.id, academicYear: ms!.academicYear.label, status: ms!.status,
          shareToken: ms!.shareToken, gradedSectionTitle: ms!.gradedSectionTitle,
          hasUnpublishedChanges: ms!.hasUnpublishedChanges,
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

    // Resolved before the transaction: the lazy find-or-create runs on
    // academicDb(), not on `tx`, so it must not be interleaved with tx writes.
    const currentYear = await resolveCurrentAcademicYear(institutionId);

    await academicDb().$transaction(async (tx) => {
      await tx.division.update({
        where: { id: divisionId },
        data: { classTeacherId: teacherId ?? null },
      });

      // Keep DivisionAssignment (the class-teacher slot: subjectId = null) in
      // sync with the denormalized Division.classTeacherId field. Scoped to the
      // current academic year so a post-rollover change creates/edits this
      // year's row instead of overwriting (or deleting) a prior year's history.
      const existingSlot = await tx.divisionAssignment.findFirst({
        where: { divisionId, subjectId: null, institutionId, academicYearId: currentYear.id },
      });

      if (teacherId === null) {
        if (existingSlot) await tx.divisionAssignment.delete({ where: { id: existingSlot.id } });
      } else if (existingSlot) {
        await tx.divisionAssignment.update({ where: { id: existingSlot.id }, data: { teacherId } });
      } else {
        await tx.divisionAssignment.create({
          data: { divisionId, institutionId, teacherId, subjectId: null, academicYearId: currentYear.id },
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

function defaultYearLabel(): string {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const startYear = month >= 5 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}
