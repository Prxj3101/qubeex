import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "../../utils/errors";
import { z } from "zod";
import { logAudit } from "../../services/audit.service";
import { assignSubjectColor } from "../../utils/subjectColors";
import { generateSignedAvatarUrlsBatch } from "../../services/storage.service";

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

export const listStandards = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);

    const standards = await prisma.standard.findMany({
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
                teacher: {
                  include: { user: { select: { id: true, name: true } } },
                },
                subject: true,
              },
            },
            _count: { select: { students: { where: { status: "ACTIVE" } } } },
          },
        },
      },
    });

    const data = standards.map((standard) => ({
      ...standard,
      divisions: standard.divisions.map((division) => ({
        ...division,
        studentCount: division._count.students,
      })),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createStandard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const data = createStandardSchema.parse(req.body);

    const existing = await prisma.standard.findUnique({
      where: { institutionId_name: { institutionId, name: data.name } },
    });
    if (existing) throw new BadRequestError("A standard with this name already exists");

    const standard = await prisma.standard.create({
      data: { institutionId, ...data, order: data.order ?? 0 },
    });

    res.status(201).json({ success: true, data: standard });
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

    const standard = await prisma.standard.findFirst({ where: { id, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    if (data.name && data.name !== standard.name) {
      const existing = await prisma.standard.findUnique({
        where: { institutionId_name: { institutionId, name: data.name } },
      });
      if (existing) throw new BadRequestError("A standard with this name already exists");
    }

    const updated = await prisma.standard.update({ where: { id }, data });
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

export const deleteStandard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;

    const standard = await prisma.standard.findFirst({ where: { id, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    await prisma.standard.delete({ where: { id } });
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

    const standard = await prisma.standard.findFirst({ where: { id: standardId, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    const existing = await prisma.division.findUnique({
      where: { standardId_name: { standardId, name: data.name } },
    });
    if (existing) throw new BadRequestError("A division with this name already exists in this standard");

    const division = await prisma.division.create({
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

    const division = await prisma.division.findFirst({ where: { id, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    if (data.name && data.name !== division.name) {
      const existing = await prisma.division.findUnique({
        where: { standardId_name: { standardId: division.standardId, name: data.name } },
      });
      if (existing) throw new BadRequestError("A division with this name already exists in this standard");
    }

    const updated = await prisma.division.update({ where: { id }, data });
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

    const division = await prisma.division.findFirst({ where: { id, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    await prisma.division.delete({ where: { id } });
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

    const standard = await prisma.standard.findFirst({ where: { id: standardId, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    const existing = await prisma.subject.findUnique({
      where: { standardId_name: { standardId, name: data.name } },
    });
    if (existing) throw new BadRequestError("A subject with this name already exists in this standard");

    const siblingCount = await prisma.subject.count({ where: { standardId } });

    const subject = await prisma.subject.create({
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

    const subject = await prisma.subject.findFirst({ where: { id, institutionId } });
    if (!subject) throw new NotFoundError("Subject not found");

    if (data.name && data.name !== subject.name) {
      const existing = await prisma.subject.findUnique({
        where: { standardId_name: { standardId: subject.standardId, name: data.name } },
      });
      if (existing) throw new BadRequestError("A subject with this name already exists in this standard");
    }

    const updated = await prisma.subject.update({ where: { id }, data });
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

    const standard = await prisma.standard.findFirst({ where: { id: standardId, institutionId } });
    if (!standard) throw new NotFoundError("Standard not found");

    const subjects = await prisma.subject.findMany({ where: { standardId, institutionId } });
    const subjectIds = new Set(subjects.map((s) => s.id));
    if (orderedIds.length !== subjects.length || !orderedIds.every((id) => subjectIds.has(id))) {
      throw new BadRequestError("orderedIds must include every subject in this standard exactly once");
    }

    // Reassigning order also reassigns color to match the new sequence
    // position — position 1 is always the first palette color, etc. Deleting
    // a subject never renumbers its surviving siblings (see deleteSubject),
    // so this only ever runs on an explicit, user-initiated reorder.
    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.subject.update({ where: { id }, data: { order: index, color: assignSubjectColor(index) } })
      )
    );

    const updated = await prisma.subject.findMany({ where: { standardId }, orderBy: { order: "asc" } });
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

    const subject = await prisma.subject.findFirst({ where: { id, institutionId } });
    if (!subject) throw new NotFoundError("Subject not found");

    await prisma.$transaction([
      prisma.divisionAssignment.deleteMany({ where: { subjectId: id } }),
      prisma.divisionSubject.deleteMany({ where: { subjectId: id } }),
      prisma.subject.delete({ where: { id } }),
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

    const division = await prisma.division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    const teacher = await prisma.teacher.findFirst({ where: { id: data.teacherId, institutionId } });
    if (!teacher) throw new NotFoundError("Teacher not found");

    if (data.subjectId) {
      const selected = await prisma.divisionSubject.findUnique({
        where: { divisionId_subjectId: { divisionId, subjectId: data.subjectId } },
      });
      if (!selected) throw new NotFoundError("Subject is not selected for this division");
    }

    // A teacher can be class teacher (null subjectId) of at most one division —
    // reject if they're already the class teacher elsewhere.
    if (data.subjectId == null) {
      const existingClassTeacherDivision = await prisma.division.findFirst({
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
    const existing = await prisma.divisionAssignment.findFirst({
      where: { divisionId, subjectId },
    });

    let assignment;
    if (existing) {
      assignment = await prisma.divisionAssignment.update({
        where: { id: existing.id },
        data: { teacherId: data.teacherId },
        include: {
          teacher: { include: { user: { select: { id: true, name: true } } } },
          subject: true,
        },
      });
    } else {
      assignment = await prisma.divisionAssignment.create({
        data: { divisionId, institutionId, teacherId: data.teacherId, subjectId },
        include: {
          teacher: { include: { user: { select: { id: true, name: true } } } },
          subject: true,
        },
      });
    }

    // A null subjectId means this is the class-teacher slot — keep the
    // denormalized Division.classTeacherId field in sync with the assignment.
    if (subjectId === null) {
      await prisma.division.update({
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
      details: `Teacher "${assignment.teacher.user.name}" assigned as ${slot} in division "${division.name}"`,
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

    const assignment = await prisma.divisionAssignment.findFirst({ where: { id, institutionId } });
    if (!assignment) throw new NotFoundError("Assignment not found");

    await prisma.divisionAssignment.delete({ where: { id } });

    // Removing the class-teacher slot (null subjectId) must also clear the
    // denormalized Division.classTeacherId, but only if it pointed at this teacher.
    if (assignment.subjectId === null) {
      await prisma.division.updateMany({
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

    const division = await prisma.division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    const subject = await prisma.subject.findFirst({
      where: { id: subjectId, standardId: division.standardId, institutionId },
    });
    if (!subject) throw new NotFoundError("Subject not found in this standard");

    await prisma.divisionSubject.upsert({
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

    const division = await prisma.division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    await prisma.divisionSubject.deleteMany({ where: { divisionId, subjectId } });
    // Also remove any teacher assignment for this subject in this division
    await prisma.divisionAssignment.deleteMany({ where: { divisionId, subjectId } });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const getDivision = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.divisionId as string;

    const division = await prisma.division.findFirst({
      where: { id, institutionId },
      include: {
        standard: {
          include: { subjects: { orderBy: { order: "asc" } } },
        },
        divisionSubjects: { select: { subjectId: true } },
        assignments: {
          include: {
            teacher: {
              include: { user: { select: { id: true, name: true } } },
            },
            subject: true,
          },
        },
      },
    });
    if (!division) throw new NotFoundError("Division not found");

    const rawUrls = division.assignments.map((a) => a.teacher.avatarUrl);
    const signedMap = await generateSignedAvatarUrlsBatch(rawUrls);
    const assignments = division.assignments.map((a) => ({
      ...a,
      teacher: {
        ...a.teacher,
        avatarUrl: a.teacher.avatarUrl ? (signedMap[a.teacher.avatarUrl] ?? a.teacher.avatarUrl) : null,
      },
    }));

    res.json({ success: true, data: { ...division, assignments } });
  } catch (err) {
    next(err);
  }
};
