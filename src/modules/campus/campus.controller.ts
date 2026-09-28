import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
import { z } from "zod";
import { logAudit } from "../../services/audit.service";
import { assignSubjectColor } from "../../utils/subjectColors";
import { generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { getCurrentAcademicYear } from "../../utils/academicYear";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createStandardSchema = z.object({
  name: z.string().min(1).max(50).trim(),
  order: z.number().int().min(0).optional(),
});

const updateStandardSchema = createStandardSchema.partial();

const createDivisionSchema = z.object({
  name: z.string().min(1).max(20).trim(),
  capacity: z.number().int().min(1).optional(),
});

const updateDivisionSchema = createDivisionSchema.partial();

const createSubjectSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  code: z.string().max(20).trim().optional(),
  color: z.string().max(20).trim().optional(),
  order: z.number().int().min(0).optional(),
});

const updateSubjectSchema = createSubjectSchema.partial();

const reorderSubjectsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

const assignTeacherSchema = z.object({
  teacherId: z.string().uuid(),
  subjectId: z.string().uuid().nullable().optional(),
});

// ── Helper ────────────────────────────────────────────────────────────────────

function requireInstitution(req: AuthRequest) {
  const { institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return institutionId;
}

// ── Standards ─────────────────────────────────────────────────────────────────

// The classes page replaces its whole standards list with whatever the server
// last returned, so every endpoint that hands standards back has to return this
// same fully-nested shape — hence one loader shared by the list and the
// reorder rather than each building its own.
async function loadStandards(institutionId: string) {
  const standards = await academicDb().standard.findMany({
    where: { institutionId },
    orderBy: { order: "asc" },
    include: {
      subjects: { orderBy: { order: "asc" } },
      divisions: {
        orderBy: { name: "asc" },
        include: {
          divisionSubjects: { select: { subjectId: true } },
          assignments: {
            include: {
              teacher: true,
              subject: true,
            },
          },
          _count: { select: { students: { where: { status: "ACTIVE" } } } },
        },
      },
    },
  });

  // Teacher names are central (Teacher may be in a tenant DB under BYOD).
  const teacherUserIds = standards.flatMap((s) =>
    s.divisions.flatMap((d) => d.assignments.map((a) => a.teacher.userId))
  );
  const users = await resolveUsers(teacherUserIds, { id: true, name: true });

  return standards.map((standard) => ({
    ...standard,
    divisions: standard.divisions.map((division) => ({
      ...division,
      assignments: division.assignments.map((a) => {
        const u = users.get(a.teacher.userId);
        return { ...a, teacher: { ...a.teacher, user: u ? { id: u.id, name: u.name } : null } };
      }),
      studentCount: division._count.students,
    })),
  }));
}

export const listStandards = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    res.json({ success: true, data: await loadStandards(institutionId) });
  } catch (err) {
    next(err);
  }
};

export const reorderStandards = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { orderedIds } = reorderSubjectsSchema.parse(req.body);

    const standards = await academicDb().standard.findMany({ where: { institutionId }, select: { id: true } });
    const ids = new Set(standards.map((s) => s.id));
    if (orderedIds.length !== standards.length || !orderedIds.every((id) => ids.has(id))) {
      throw new BadRequestError("orderedIds must include every standard exactly once");
    }

    await academicDb().$transaction(
      orderedIds.map((id, index) => academicDb().standard.update({ where: { id }, data: { order: index } }))
    );

    res.json({ success: true, data: await loadStandards(institutionId) });
    logAudit("CLASS_UPDATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: "Classes reordered",
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const createStandard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const data = createStandardSchema.parse(req.body);

    const existing = await academicDb().standard.findUnique({
      where: { institutionId_name: { institutionId, name: data.name } },
    });
    if (existing) throw new BadRequestError("A standard with this name already exists");

    const standard = await academicDb().standard.create({
      data: { institutionId, ...data, order: data.order ?? 0 },
    });

    // A brand-new standard has no subjects/divisions yet — the frontend appends
    // this response directly into the same list `listStandards` populates, so
    // the shape must match (it reads std.subjects / std.divisions unguarded).
    res.status(201).json({ success: true, data: { ...standard, subjects: [], divisions: [] } });
    logAudit("CLASS_CREATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Standard "${standard.name}" created`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const updateStandard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;
    const data = updateStandardSchema.parse(req.body);

    const standard = await academicDb().standard.findFirst({ where: { id, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    if (data.name && data.name !== standard.name) {
      const existing = await academicDb().standard.findUnique({
        where: { institutionId_name: { institutionId, name: data.name } },
      });
      if (existing) throw new BadRequestError("A standard with this name already exists");
    }

    const updated = await academicDb().standard.update({ where: { id }, data });
    res.json({ success: true, data: updated });
    logAudit("CLASS_UPDATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Standard "${updated.name}" updated`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

// Everything that hangs off a Division, in dependency order, ready to drop into
// a $transaction. Only the top of each tree is listed: the rows underneath —
// marksheet scores and remarks, test questions and attempts and answers,
// assignment submissions — are declared onDelete: Cascade in the tenant schema,
// so removing the parent takes them with it. Campus posts and calendar events
// link to a division optionally, so Prisma nulls those out by itself and they
// simply become institution-wide.
const divisionCleanupOps = (divisionIds: string[]) => {
  const db = academicDb();
  const where = { divisionId: { in: divisionIds } };
  return [
    db.marksheet.deleteMany({ where }),
    db.attendance.deleteMany({ where }),
    db.attendanceDayNote.deleteMany({ where }),
    db.divisionFeeStructure.deleteMany({ where }),
    db.taskAssignment.deleteMany({ where }),
    db.taskTest.deleteMany({ where }),
    db.taskContainer.deleteMany({ where }),
    db.divisionAssignment.deleteMany({ where }),
    db.divisionSubject.deleteMany({ where }),
  ];
};

export const deleteStandard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;

    const standard = await academicDb().standard.findFirst({ where: { id, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    // Divisions are never taken down along with their class — they're their own
    // thing, each potentially holding a year of attendance and marksheets, so
    // deleting one has to be a deliberate act. The class delete stops here and
    // names them instead. Students are checked too, in case any are attached to
    // the class without sitting in a division.
    const [divisions, students] = await Promise.all([
      academicDb().division.findMany({ where: { standardId: id }, select: { name: true }, orderBy: { name: "asc" } }),
      academicDb().student.count({ where: { standardId: id } }),
    ]);

    if (divisions.length > 0) {
      const names = divisions.map((d) => d.name).join(", ");
      throw new ConflictError(
        `This class still has division${divisions.length === 1 ? "" : "s"} ${names}. Delete ${divisions.length === 1 ? "it" : "them"} first, then the class.`
      );
    }
    if (students > 0) {
      throw new ConflictError(
        `This class still has ${students} student${students === 1 ? "" : "s"}. Move or remove them before deleting it.`
      );
    }

    // With no divisions left, all that's holding the class are its subjects —
    // configuration rather than records — and whatever hangs off them. Those go
    // quietly, otherwise the delete would just trip Subject_standardId_fkey next.
    const subjects = await academicDb().subject.findMany({ where: { standardId: id }, select: { id: true } });
    const bySubject = { subjectId: { in: subjects.map((s) => s.id) } };

    await academicDb().$transaction([
      academicDb().taskModule.deleteMany({ where: bySubject }),
      academicDb().taskAssignment.deleteMany({ where: bySubject }),
      academicDb().taskTest.deleteMany({ where: bySubject }),
      academicDb().taskContainer.deleteMany({ where: bySubject }),
      academicDb().divisionAssignment.deleteMany({ where: bySubject }),
      academicDb().divisionSubject.deleteMany({ where: bySubject }),
      academicDb().subject.deleteMany({ where: { standardId: id } }),
      academicDb().standard.delete({ where: { id } }),
    ]);

    res.json({ success: true });
    logAudit("CLASS_DELETED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Standard "${standard.name}" deleted`,
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });
  } catch (err) {
    next(err);
  }
};

// ── Divisions ─────────────────────────────────────────────────────────────────

export const createDivision = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const standardId = req.params.standardId as string;
    const data = createDivisionSchema.parse(req.body);

    const standard = await academicDb().standard.findFirst({ where: { id: standardId, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    const existing = await academicDb().division.findUnique({
      where: { standardId_name: { standardId, name: data.name } },
    });
    if (existing) throw new BadRequestError("A division with this name already exists in this standard");

    const division = await academicDb().division.create({
      data: { standardId, institutionId, ...data },
      include: { assignments: true },
    });

    res.status(201).json({ success: true, data: division });
    logAudit("CLASS_CREATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Division "${division.name}" created under standard "${standard.name}"`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const updateDivision = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.divisionId as string;
    const data = updateDivisionSchema.parse(req.body);

    const division = await academicDb().division.findFirst({ where: { id, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    if (data.name && data.name !== division.name) {
      const existing = await academicDb().division.findUnique({
        where: { standardId_name: { standardId: division.standardId, name: data.name } },
      });
      if (existing) throw new BadRequestError("A division with this name already exists in this standard");
    }

    const updated = await academicDb().division.update({ where: { id }, data });
    res.json({ success: true, data: updated });
    logAudit("CLASS_UPDATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Division "${updated.name}" updated`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const deleteDivision = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.divisionId as string;

    const division = await academicDb().division.findFirst({ where: { id, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    // Students are the only thing that stops a division being deleted —
    // everything else it owns goes with it (see divisionCleanupOps). A dozen
    // tables reference a Division and none of those relations cascade, which is
    // why deleting one outright used to crash on whichever foreign key tripped
    // first (DivisionAssignment, in practice).
    const students = await academicDb().student.count({ where: { divisionId: id } });
    if (students > 0) {
      throw new ConflictError(
        `This division still has ${students} student${students === 1 ? "" : "s"}. Move or remove them before deleting it.`
      );
    }

    await academicDb().$transaction([
      ...divisionCleanupOps([id]),
      academicDb().division.delete({ where: { id } }),
    ]);

    res.json({ success: true });
    logAudit("CLASS_DELETED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Division "${division.name}" deleted`,
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });
  } catch (err) {
    next(err);
  }
};

// ── Subjects ──────────────────────────────────────────────────────────────────

export const createSubject = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const standardId = req.params.standardId as string;
    const data = createSubjectSchema.parse(req.body);

    const standard = await academicDb().standard.findFirst({ where: { id: standardId, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    const existing = await academicDb().subject.findUnique({
      where: { standardId_name: { standardId, name: data.name } },
    });
    if (existing) throw new BadRequestError("A subject with this name already exists in this standard");

    const siblingCount = await academicDb().subject.count({ where: { standardId } });

    const subject = await academicDb().subject.create({
      data: {
        standardId,
        institutionId,
        ...data,
        color: data.color ?? assignSubjectColor(siblingCount),
        order: data.order ?? siblingCount,
      },
    });

    res.status(201).json({ success: true, data: subject });
    logAudit("SUBJECT_CREATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Subject "${subject.name}" added to standard "${standard.name}"`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const updateSubject = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.subjectId as string;
    const data = updateSubjectSchema.parse(req.body);

    const subject = await academicDb().subject.findFirst({ where: { id, institutionId } });
    if (!subject) throw new NotFoundError("Subject not found");

    if (data.name && data.name !== subject.name) {
      const existing = await academicDb().subject.findUnique({
        where: { standardId_name: { standardId: subject.standardId, name: data.name } },
      });
      if (existing) throw new BadRequestError("A subject with this name already exists in this standard");
    }

    const updated = await academicDb().subject.update({ where: { id }, data });
    res.json({ success: true, data: updated });
    logAudit("SUBJECT_UPDATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Subject "${updated.name}" updated`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const reorderSubjects = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const standardId = req.params.standardId as string;
    const { orderedIds } = reorderSubjectsSchema.parse(req.body);

    const standard = await academicDb().standard.findFirst({ where: { id: standardId, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    const subjects = await academicDb().subject.findMany({ where: { standardId, institutionId } });
    const subjectIds = new Set(subjects.map((s) => s.id));
    if (orderedIds.length !== subjects.length || !orderedIds.every((id) => subjectIds.has(id))) {
      throw new BadRequestError("orderedIds must include every subject in this standard exactly once");
    }

    // Reassigning order also reassigns color to match the new sequence
    // position — position 1 is always the first palette color, etc. Deleting
    // a subject never renumbers its surviving siblings (see deleteSubject),
    // so this only ever runs on an explicit, user-initiated reorder.
    await academicDb().$transaction(
      orderedIds.map((id, index) =>
        academicDb().subject.update({ where: { id }, data: { order: index, color: assignSubjectColor(index) } })
      )
    );

    const updated = await academicDb().subject.findMany({ where: { standardId }, orderBy: { order: "asc" } });
    res.json({ success: true, data: updated });
    logAudit("SUBJECT_UPDATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Subjects reordered in standard "${standard.name}"`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const deleteSubject = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.subjectId as string;

    const subject = await academicDb().subject.findFirst({ where: { id, institutionId } });
    if (!subject) throw new NotFoundError("Subject not found");

    await academicDb().$transaction([
      academicDb().divisionAssignment.deleteMany({ where: { subjectId: id } }),
      academicDb().divisionSubject.deleteMany({ where: { subjectId: id } }),
      academicDb().subject.delete({ where: { id } }),
    ]);
    res.json({ success: true });
    logAudit("SUBJECT_DELETED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Subject "${subject.name}" deleted`,
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });
  } catch (err) {
    next(err);
  }
};

// ── Teacher assignments ───────────────────────────────────────────────────────

export const assignTeacher = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const data = assignTeacherSchema.parse(req.body);

    const division = await academicDb().division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    const teacher = await academicDb().teacher.findFirst({ where: { id: data.teacherId, institutionId } });
    if (!teacher) throw new NotFoundError("Teacher not found");

    if (data.subjectId) {
      const selected = await academicDb().divisionSubject.findUnique({
        where: { divisionId_subjectId: { divisionId, subjectId: data.subjectId } },
      });
      if (!selected) throw new NotFoundError("Subject is not selected for this division");
    }

    // A teacher can be class teacher (null subjectId) of at most one division —
    // reject if they're already the class teacher elsewhere.
    if (data.subjectId == null) {
      const existingClassTeacherDivision = await academicDb().division.findFirst({
        where: { institutionId, classTeacherId: data.teacherId, id: { not: divisionId } },
        select: { name: true, standard: { select: { name: true } } },
      });
      if (existingClassTeacherDivision) {
        throw new ConflictError(
          `Teacher is already class teacher of ${existingClassTeacherDivision.standard.name} - ${existingClassTeacherDivision.name}`
        );
      }
    }

    // Upsert: replace existing assignment for this slot
    // findUnique can't handle null in compound unique, so use findFirst
    const subjectId = data.subjectId ?? null;
    const existing = await academicDb().divisionAssignment.findFirst({
      where: { divisionId, subjectId },
    });

    let assignment;
    if (existing) {
      assignment = await academicDb().divisionAssignment.update({
        where: { id: existing.id },
        data: { teacherId: data.teacherId },
        include: { teacher: true, subject: true },
      });
    } else {
      const currentYear = await getCurrentAcademicYear(institutionId);
      assignment = await academicDb().divisionAssignment.create({
        data: { divisionId, institutionId, teacherId: data.teacherId, subjectId, academicYearId: currentYear.id },
        include: { teacher: true, subject: true },
      });
    }
    const assignTeacherUser = (await resolveUsers([assignment.teacher.userId], { id: true, name: true })).get(assignment.teacher.userId);
    assignment = { ...assignment, teacher: { ...assignment.teacher, user: assignTeacherUser ?? null } };

    // A null subjectId means this is the class-teacher slot — keep the
    // denormalized Division.classTeacherId field in sync with the assignment.
    if (subjectId === null) {
      await academicDb().division.update({
        where: { id: divisionId },
        data: { classTeacherId: data.teacherId },
      });
    }

    res.status(201).json({ success: true, data: assignment });
    const slot = data.subjectId ? `subject "${assignment.subject?.name}"` : "class teacher";
    logAudit("TEACHER_ASSIGNED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Teacher "${assignment.teacher.user?.name}" assigned as ${slot} in division "${division.name}"`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const removeAssignment = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.assignmentId as string;

    const assignment = await academicDb().divisionAssignment.findFirst({ where: { id, institutionId } });
    if (!assignment) throw new NotFoundError("Assignment not found");

    await academicDb().divisionAssignment.delete({ where: { id } });

    // Removing the class-teacher slot (null subjectId) must also clear the
    // denormalized Division.classTeacherId, but only if it pointed at this teacher.
    if (assignment.subjectId === null) {
      await academicDb().division.updateMany({
        where: { id: assignment.divisionId, institutionId, classTeacherId: assignment.teacherId },
        data: { classTeacherId: null },
      });
    }

    res.json({ success: true });
    logAudit("TEACHER_UNASSIGNED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Teacher assignment removed`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

// ── Division subject selection ────────────────────────────────────────────────

export const selectSubject = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const subjectId = req.params.subjectId as string;

    const division = await academicDb().division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    const subject = await academicDb().subject.findFirst({
      where: { id: subjectId, standardId: division.standardId, institutionId },
    });
    if (!subject) throw new NotFoundError("Subject not found in this standard");

    await academicDb().divisionSubject.upsert({
      where: { divisionId_subjectId: { divisionId, subjectId } },
      create: { divisionId, subjectId, institutionId },
      update: {},
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const deselectSubject = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const subjectId = req.params.subjectId as string;

    const division = await academicDb().division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    await academicDb().divisionSubject.deleteMany({ where: { divisionId, subjectId } });
    // Also remove any teacher assignment for this subject in this division
    await academicDb().divisionAssignment.deleteMany({ where: { divisionId, subjectId } });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const getDivision = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.divisionId as string;

    const division = await academicDb().division.findFirst({
      where: { id, institutionId },
      include: {
        standard: {
          include: { subjects: { orderBy: { order: "asc" } } },
        },
        divisionSubjects: { select: { subjectId: true } },
        assignments: {
          include: {
            teacher: true,
            subject: true,
          },
        },
      },
    });
    if (!division) throw new NotFoundError("Division not found");

    const divisionTeacherUserMap = await resolveUsers(division.assignments.map((a) => a.teacher.userId), { id: true, name: true });
    const rawUrls = division.assignments.map((a) => a.teacher.avatarUrl);
    const signedMap = await generateSignedAvatarUrlsBatch(rawUrls);
    const assignments = division.assignments.map((a) => ({
      ...a,
      teacher: {
        ...a.teacher,
        user: divisionTeacherUserMap.get(a.teacher.userId) ?? null,
        avatarUrl: a.teacher.avatarUrl ? (signedMap[a.teacher.avatarUrl] ?? a.teacher.avatarUrl) : null,
      },
    }));

    res.json({ success: true, data: { ...division, assignments } });
  } catch (err) {
    next(err);
  }
};
