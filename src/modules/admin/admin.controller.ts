import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { checkInstitutionAccess } from "../../utils/authorization";
import { uploadImageToSupabase, generateSignedAvatarUrl, generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { logAudit } from "../../services/audit.service";
import { NotFoundError, BadRequestError } from "../../utils/errors";
import { generateToken, hashToken } from "../../utils/token";
import { sendTeacherInviteEmail, sendSubAdminInviteEmail } from "../../services/email.service";
import { cacheSubAdminPermissions } from "../../middlewares/requirePermission.middleware";
import { generateUserId } from "../../utils/userId";
import { z } from "zod";

const updateInstitutionSchema = z.object({
  name: z.string().min(2).max(200).trim().optional(),
  email: z.string().email().max(255).toLowerCase().trim().optional(),
  phone: z.string().max(20).trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  pincode: z.string().trim().optional().nullable(),
  board: z.string().trim().optional().nullable(),
  medium: z.string().trim().optional().nullable(),
  establishedOn: z.string().trim().optional().nullable(),
});

const updateAdminMeSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  prefix: z.string().max(20).trim().optional().nullable(),
  title: z.string().max(100).trim().optional().nullable(),
  phone: z.string().max(20).trim().optional().nullable(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
});

const addTeacherSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: z.string().email().toLowerCase().trim(),
  phone: z.string().max(20).trim().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  address: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  country: z.string().trim().optional(),
  qualification: z.string().trim().optional(),
  experience: z.string().trim().optional(),
});

const updateTeacherSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  phone: z.string().max(20).trim().optional().nullable(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state: z.string().trim().optional().nullable(),
  pincode: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  qualification: z.string().trim().optional().nullable(),
  experience: z.string().trim().optional().nullable(),
  avatarUrl: z.string().url().optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const VALID_PERMISSIONS = [
  "STAFF_TEACHERS",
  "STAFF_STAFFROOM",
  "STAFF_SUBADMINS",
  "CAMPUS_FEED",
  "CAMPUS_VIEW",
  "CAMPUS_MANAGE",
  "CAMPUS_FEES",
  "CAMPUS_ATTENDANCE",
  "CAMPUS_MARKSHEET",
  "INSIGHTS",
  "SUPPORT",
  "AUDIT_LOGS",
] as const;

const addSubAdminSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: z.string().email().toLowerCase().trim(),
  permissions: z.array(z.enum(VALID_PERMISSIONS)).min(1, "Grant at least one permission"),
  designation: z.string().max(100).trim().optional(),
  phone: z.string().max(20).trim().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  address: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  country: z.string().trim().optional(),
  qualification: z.string().trim().optional(),
  experience: z.string().trim().optional(),
});

const updateSubAdminPermissionsSchema = z.object({
  permissions: z.array(z.enum(VALID_PERMISSIONS)).min(1, "Grant at least one permission"),
});

const addStudentSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: z.string().email().toLowerCase().trim(),
  phone: z.string().max(20).trim().optional(),
  standardId: z.string().uuid().optional(),
  divisionId: z.string().uuid().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  address: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  country: z.string().trim().optional(),
});

const updateStudentSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  phone: z.string().max(20).trim().optional().nullable(),
  standardId: z.string().uuid().optional().nullable(),
  divisionId: z.string().uuid().optional().nullable(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state: z.string().trim().optional().nullable(),
  pincode: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  avatarUrl: z.string().url().optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const getMyInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;

    if (!user.institutionId) {
      throw new BadRequestError("No institution associated with this account");
    }

    checkInstitutionAccess(user, user.institutionId);

    const institution = await prisma.institution.findUnique({
      where: { id: user.institutionId },
      include: {
        users: {
          omit: { password: true },
        },
        subscription: true,
      },
    });

    if (!institution) {
      throw new NotFoundError("Institution not found");
    }

    let adminAvatarUrl = institution.adminAvatarUrl;
    if (adminAvatarUrl) {
      const signed = await generateSignedAvatarUrl(adminAvatarUrl);
      if (signed) adminAvatarUrl = signed;
    }

    res.json({ success: true, data: { ...institution, adminAvatarUrl } });
  } catch (error) {
    next(error);
  }
};

export const updateMyInstitution = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;

    if (!user.institutionId) {
      throw new BadRequestError("No institution associated with this account");
    }

    checkInstitutionAccess(user, user.institutionId);

    const data = updateInstitutionSchema.parse(req.body);
    const institution = await prisma.institution.update({
      where: { id: user.institutionId },
      data,
    });

    logAudit("INSTITUTION_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institution.id,
      details: `${institution.name} details updated`,
      metadata: { email: institution.email },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.json({ success: true, data: institution });
  } catch (error) {
    next(error);
  }
};

export const updateAdminMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    if (!user.institutionId) throw new BadRequestError("No institution associated with this account");
    checkInstitutionAccess(user, user.institutionId);

    const data = updateAdminMeSchema.parse(req.body);

    // Update User.name if provided
    if (data.name) {
      await prisma.user.update({ where: { id: user.userId }, data: { name: data.name } });
    }

    // Store prefix/title/phone/dob/gender on Institution (one admin per institution)
    const { name: _name, ...institutionFields } = data;
    const institutionUpdate: Record<string, string | null | undefined> = {};
    if ('prefix' in institutionFields) institutionUpdate.adminPrefix = institutionFields.prefix;
    if ('title' in institutionFields) institutionUpdate.adminTitle = institutionFields.title;
    if ('phone' in institutionFields) institutionUpdate.adminPhone = institutionFields.phone;
    if ('dob' in institutionFields) institutionUpdate.adminDob = institutionFields.dob;
    if ('gender' in institutionFields) institutionUpdate.adminGender = institutionFields.gender;

    if (Object.keys(institutionUpdate).length > 0) {
      await prisma.institution.update({ where: { id: user.institutionId }, data: institutionUpdate });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const uploadAdminPhoto = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    if (!user.institutionId) throw new BadRequestError("No institution associated with this account");
    checkInstitutionAccess(user, user.institutionId);

    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!file.length) throw new BadRequestError("No photo file provided");

    const { publicUrl } = await uploadImageToSupabase(file, {
      contentType: req.headers["content-type"] ?? "",
      folder: "admin-photos",
      ownerId: user.institutionId,
    });

    await prisma.institution.update({
      where: { id: user.institutionId },
      data: { adminAvatarUrl: publicUrl },
    });

    const signedUrl = (await generateSignedAvatarUrl(publicUrl)) ?? publicUrl;
    res.json({ success: true, data: { avatarUrl: signedUrl } });
  } catch (error) {
    next(error);
  }
};

export const uploadMyInstitutionLogo = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;

    if (!user.institutionId) {
      throw new BadRequestError("No institution associated with this account");
    }

    checkInstitutionAccess(user, user.institutionId);

    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const uploaded = await uploadImageToSupabase(file, {
      contentType: req.headers["content-type"] ?? "",
      folder: "institutions/logos",
      ownerId: user.institutionId,
    });

    const institution = await prisma.institution.update({
      where: { id: user.institutionId },
      data: { logoUrl: uploaded.publicUrl },
    });

    logAudit("INSTITUTION_LOGO_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institution.id,
      details: `${institution.name} logo updated`,
      metadata: { path: uploaded.path, logoUrl: uploaded.publicUrl },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.json({
      success: true,
      data: { logoUrl: uploaded.publicUrl, path: uploaded.path, institution },
    });
  } catch (error) {
    next(error);
  }
};

export const listTeachers = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const teachers = await prisma.teacher.findMany({
      where: { institutionId },
      include: { user: { omit: { password: true } } },
      orderBy: { createdAt: "asc" },
    });

    const pendingInviteEmails = new Set(
      (await prisma.invite.findMany({
        where: {
          institutionId: institutionId!,
          role: "TEACHER",
          isUsed: false,
        },
        select: { email: true },
      })).map(i => i.email)
    );

    const rawAvatarUrls = teachers.map(t => t.avatarUrl);
    const signedMap = await generateSignedAvatarUrlsBatch(rawAvatarUrls);

    const data = teachers.map((t) => ({
      id: t.id,
      teacherId: t.teacherId,
      name: t.user.name,
      email: t.user.email,
      phone: t.phone,
      avatarUrl: t.avatarUrl ? (signedMap[t.avatarUrl] ?? t.avatarUrl) : null,
      status: t.status,
      invitePending: pendingInviteEmails.has(t.user.email),
      joinedAt: t.joinedAt.toISOString(),
      assignments: [],
      dob: t.dob,
      gender: t.gender,
      address: t.address,
      city: t.city,
      state: t.state,
      pincode: t.pincode,
      country: t.country,
      qualification: t.qualification,
      experience: t.experience,
    }));

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const addTeacher = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const data = addTeacherSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new BadRequestError("A user with this email already exists");

    const institution = await prisma.institution.findUnique({ where: { id: institutionId! } });
    if (!institution) throw new NotFoundError("Institution not found");

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    const teacher = await prisma.$transaction(async (tx) => {
      const teacherId = await generateUserId(institutionId!, "T", tx);

      const newUser = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          role: "TEACHER",
          institutionId: institutionId!,
          isActive: false,
        },
      });

      const newTeacher = await tx.teacher.create({
        data: {
          teacherId,
          userId: newUser.id,
          institutionId: institutionId!,
          phone: data.phone,
          dob: data.dob,
          gender: data.gender,
          address: data.address,
          city: data.city,
          state: data.state,
          pincode: data.pincode,
          country: data.country ?? "India",
          qualification: data.qualification,
          experience: data.experience,
        },
        include: { user: { omit: { password: true } } },
      });

      await tx.invite.create({
        data: {
          email: data.email,
          tokenHash,
          role: "TEACHER",
          institutionId: institutionId!,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      return newTeacher;
    });

    const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
    sendTeacherInviteEmail({
      to: data.email,
      name: data.name,
      institutionName: institution.name,
      inviteLink,
    }).catch((err) => console.error("Teacher invite email failed:", err));

    logAudit("TEACHER_ADDED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `${data.name} added as teacher`,
      metadata: { teacherId: teacher.teacherId, email: data.email },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.status(201).json({
      success: true,
      data: {
        id: teacher.id,
        teacherId: teacher.teacherId,
        name: teacher.user.name,
        email: teacher.user.email,
        phone: teacher.phone,
        avatarUrl: teacher.avatarUrl,
        status: teacher.status,
        invitePending: true,
        joinedAt: teacher.joinedAt.toISOString(),
        assignments: [],
        dob: teacher.dob,
        gender: teacher.gender,
        address: teacher.address,
        city: teacher.city,
        state: teacher.state,
        pincode: teacher.pincode,
        country: teacher.country,
        qualification: teacher.qualification,
        experience: teacher.experience,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getTeacher = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const teacher = await prisma.teacher.findFirst({
      where: { id, institutionId: institutionId! },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,
            institutionId: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!teacher) throw new NotFoundError("Teacher not found");

    const pendingInvite = await prisma.invite.findFirst({
      where: {
        email: teacher.user.email,
        institutionId: institutionId!,
        role: "TEACHER",
        isUsed: false,
      },
      select: { id: true },
    });

    res.json({
      success: true,
      data: {
        id: teacher.id,
        teacherId: teacher.teacherId,
        name: teacher.user.name,
        email: teacher.user.email,
        phone: teacher.phone,
        avatarUrl: teacher.avatarUrl,
        status: teacher.status,
        invitePending: pendingInvite !== null,
        joinedAt: teacher.joinedAt.toISOString(),
        assignments: [],
        experience: teacher.experience,
        city: teacher.city,
        state: teacher.state,
        qualification: teacher.qualification,
        dob: teacher.dob,
        gender: teacher.gender,
        address: teacher.address,
        pincode: teacher.pincode,
        country: teacher.country,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateTeacher = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const data = updateTeacherSchema.parse(req.body);

    const existing = await prisma.teacher.findFirst({
      where: { id, institutionId: institutionId! },
    });
    if (!existing) throw new NotFoundError("Teacher not found");

    const { name, status, ...profileFields } = data;

    const userSelect = {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      institutionId: true,
      createdAt: true,
      updatedAt: true,
    } as const;

    const teacher = await prisma.$transaction(async (tx) => {
      const userChanges: { isActive?: boolean; name?: string } = {};
      if (status !== undefined) userChanges.isActive = status === "ACTIVE";
      if (name !== undefined) userChanges.name = name;
      if (Object.keys(userChanges).length > 0) {
        await tx.user.update({ where: { id: existing.userId }, data: userChanges });
      }

      return tx.teacher.update({
        where: { id },
        data: {
          ...profileFields,
          ...(status !== undefined ? { status } : {}),
        },
        include: { user: { select: userSelect } },
      });
    });

    const pendingInviteForUpdate = await prisma.invite.findFirst({
      where: {
        email: teacher.user.email,
        institutionId: institutionId!,
        role: "TEACHER",
        isUsed: false,
      },
      select: { id: true },
    });

    {
      const actionName = data.status === "INACTIVE"
        ? "TEACHER_DEACTIVATED"
        : data.status === "ACTIVE"
        ? "TEACHER_ACTIVATED"
        : "TEACHER_UPDATED";
      const severityLevel = data.status === "INACTIVE" ? "WARNING" : "INFO";
      const detailsText = data.status === "INACTIVE"
        ? `Teacher ${teacher.user.name} deactivated`
        : data.status === "ACTIVE"
        ? `Teacher ${teacher.user.name} activated`
        : `Teacher ${teacher.user.name} updated`;
      logAudit(actionName, {
        userId: user.userId,
        actorRole: user.role,
        institutionId: institutionId!,
        details: detailsText,
        metadata: { teacherId: teacher.teacherId, changes: Object.keys(data) },
        category: "ADMIN_ACTION",
        severity: severityLevel as "INFO" | "WARNING",
      });
    }

    res.json({
      success: true,
      data: {
        id: teacher.id,
        teacherId: teacher.teacherId,
        name: teacher.user.name,
        email: teacher.user.email,
        phone: teacher.phone,
        avatarUrl: teacher.avatarUrl,
        status: teacher.status,
        invitePending: pendingInviteForUpdate !== null,
        joinedAt: teacher.joinedAt.toISOString(),
        assignments: [],
        experience: teacher.experience,
        city: teacher.city,
        state: teacher.state,
        qualification: teacher.qualification,
        dob: teacher.dob,
        gender: teacher.gender,
        address: teacher.address,
        pincode: teacher.pincode,
        country: teacher.country,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /admin/structure ───────────────────────────────────────────────────────
// Aggregates campus standards + divisions into the InstitutionStructure shape
// expected by the teachers page and assignment modals.
export const getInstitutionStructure = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    if (!user.institutionId) throw new BadRequestError("No institution associated with this account");

    const institution = await prisma.institution.findUnique({
      where: { id: user.institutionId },
      select: { type: true },
    });

    const standards = await prisma.standard.findMany({
      where: { institutionId: user.institutionId },
      orderBy: { order: "asc" },
      include: {
        subjects: { orderBy: { order: "asc" } },
        divisions: {
          orderBy: { name: "asc" },
          include: {
            assignments: {
              include: {
                teacher: { include: { user: { select: { id: true, name: true } } } },
                subject: true,
              },
            },
          },
        },
      },
    });

    // Map to InstitutionStructure shape used by the frontend
    const levels = standards.map((std) => ({
      id: std.id,
      name: std.name,
      code: undefined,
      order: std.order,
      children: std.divisions.map((div) => ({
        id: div.id,
        name: div.name,
        code: undefined,
        order: 0,
        children: std.subjects.map((sub) => ({
          id: sub.id,
          name: sub.name,
          code: sub.code ?? undefined,
          capacity: div.capacity ?? undefined,
          teacherCount: div.assignments.filter((a: { subjectId: string | null }) => a.subjectId === sub.id).length,
          studentCount: 0,
        })),
      })),
    }));

    res.json({
      success: true,
      data: {
        institutionType: institution?.type ?? "SCHOOL",
        levels,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /admin/teachers/:id/avatar ───────────────────────────────────────────
export const uploadTeacherAvatar = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    if (!user.institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const teacher = await prisma.teacher.findFirst({
      where: { id, institutionId: user.institutionId },
    });
    if (!teacher) throw new NotFoundError("Teacher not found");

    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const uploaded = await uploadImageToSupabase(file, {
      contentType: req.headers["content-type"] ?? "",
      folder: "teachers/avatars",
      ownerId: id,
    });

    const updated = await prisma.teacher.update({
      where: { id },
      data: { avatarUrl: uploaded.publicUrl },
    });

    logAudit("TEACHER_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: user.institutionId,
      details: `Teacher avatar updated`,
      metadata: { teacherId: teacher.teacherId, path: uploaded.path },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.json({ success: true, data: { avatarUrl: updated.avatarUrl } });
  } catch (error) {
    next(error);
  }
};

export const listStudents = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const students = await prisma.student.findMany({
      where: { institutionId },
      include: {
        user: { select: { name: true, email: true } },
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      success: true,
      data: students.map((s) => ({
        id: s.id,
        studentId: s.studentId,
        name: s.user.name,
        email: s.user.email,
        phone: s.phone,
        avatarUrl: s.avatarUrl,
        status: s.status,
        joinedAt: s.joinedAt.toISOString(),
        standard: s.standard,
        division: s.division,
      })),
    });
  } catch (error) {
    next(error);
  }
};

export const addStudent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const data = addStudentSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new BadRequestError("A user with this email already exists");

    if (data.divisionId) {
      const division = await prisma.division.findFirst({ where: { id: data.divisionId, institutionId } });
      if (!division) throw new NotFoundError("Division not found");
      if (data.standardId && division.standardId !== data.standardId) {
        throw new BadRequestError("Selected division does not belong to the selected standard");
      }
    }
    if (data.standardId) {
      const standard = await prisma.standard.findFirst({ where: { id: data.standardId, institutionId } });
      if (!standard) throw new NotFoundError("Standard not found");
    }

    const student = await prisma.$transaction(async (tx) => {
      const studentId = await generateUserId(institutionId, "S", tx);

      const newUser = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          role: "STUDENT",
          institutionId,
          isActive: true,
        },
      });

      return tx.student.create({
        data: {
          studentId,
          userId: newUser.id,
          institutionId,
          standardId: data.standardId,
          divisionId: data.divisionId,
          phone: data.phone,
          dob: data.dob,
          gender: data.gender,
          address: data.address,
          city: data.city,
          state: data.state,
          pincode: data.pincode,
          country: data.country ?? "India",
        },
        include: {
          user: { select: { name: true, email: true } },
          standard: { select: { id: true, name: true } },
          division: { select: { id: true, name: true } },
        },
      });
    });

    logAudit("STUDENT_ADDED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId,
      details: `${student.user.name} added as student`,
      metadata: { studentId: student.studentId, email: student.user.email },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.status(201).json({ success: true, data: student });
  } catch (error) {
    next(error);
  }
};

export const getStudent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const student = await prisma.student.findFirst({
      where: { id, institutionId },
      include: {
        user: { select: { name: true, email: true } },
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });
    if (!student) throw new NotFoundError("Student not found");

    res.json({ success: true, data: student });
  } catch (error) {
    next(error);
  }
};

export const updateStudent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;
    const data = updateStudentSchema.parse(req.body);

    const existing = await prisma.student.findFirst({
      where: { id, institutionId },
      include: { division: { select: { standardId: true } } },
    });
    if (!existing) throw new NotFoundError("Student not found");

    if (data.divisionId) {
      const division = await prisma.division.findFirst({ where: { id: data.divisionId, institutionId } });
      if (!division) throw new NotFoundError("Division not found");
      const standardId = data.standardId ?? existing.standardId;
      if (standardId && division.standardId !== standardId) {
        throw new BadRequestError("Selected division does not belong to the selected standard");
      }
    }

    if (data.standardId) {
      const standard = await prisma.standard.findFirst({ where: { id: data.standardId, institutionId } });
      if (!standard) throw new NotFoundError("Standard not found");
    }

    const { name, status, ...profileFields } = data;
    const student = await prisma.$transaction(async (tx) => {
      const userChanges: { isActive?: boolean; name?: string } = {};
      if (status !== undefined) userChanges.isActive = status === "ACTIVE";
      if (name !== undefined) userChanges.name = name;
      if (Object.keys(userChanges).length > 0) {
        await tx.user.update({ where: { id: existing.userId }, data: userChanges });
      }

      return tx.student.update({
        where: { id },
        data: {
          ...profileFields,
          ...(status !== undefined ? { status } : {}),
        },
        include: {
          user: { select: { name: true, email: true } },
          standard: { select: { id: true, name: true } },
          division: { select: { id: true, name: true } },
        },
      });
    });

    {
      const studentAction = data.status === "INACTIVE"
        ? "STUDENT_DEACTIVATED"
        : data.status === "ACTIVE"
        ? "STUDENT_ACTIVATED"
        : "STUDENT_UPDATED";
      const studentSeverity = data.status === "INACTIVE" ? "WARNING" : "INFO";
      const studentDetails = data.status === "INACTIVE"
        ? `Student ${student.user.name} deactivated`
        : data.status === "ACTIVE"
        ? `Student ${student.user.name} activated`
        : `Student ${student.user.name} updated`;
      logAudit(studentAction, {
        userId: user.userId,
        actorRole: user.role,
        institutionId,
        details: studentDetails,
        metadata: { studentId: student.studentId, changes: Object.keys(data) },
        category: "ADMIN_ACTION",
        severity: studentSeverity as "INFO" | "WARNING",
      });
    }

    res.json({ success: true, data: student });
  } catch (error) {
    next(error);
  }
};

export const resendTeacherInvite = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const teacher = await prisma.teacher.findFirst({
      where: { id, institutionId },
      include: { user: { select: { id: true, name: true, email: true, isActive: true } } },
    });
    if (!teacher) throw new NotFoundError("Teacher not found");

    if (teacher.user.isActive) {
      throw new BadRequestError("Teacher has already accepted the invite");
    }
    if (teacher.status === "INACTIVE") {
      throw new BadRequestError("Cannot resend invite to a deactivated teacher");
    }

    const institution = await prisma.institution.findUnique({
      where: { id: institutionId },
      select: { name: true },
    });
    if (!institution) throw new NotFoundError("Institution not found");

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    await prisma.$transaction(async (tx) => {
      // Invalidate all existing unused invites for this email
      await tx.invite.updateMany({
        where: { email: teacher.user.email, institutionId, isUsed: false },
        data: { isUsed: true },
      });

      // Create a fresh invite
      await tx.invite.create({
        data: {
          email: teacher.user.email,
          tokenHash,
          role: "TEACHER",
          institutionId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
    });

    const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
    await sendTeacherInviteEmail({
      to: teacher.user.email,
      name: teacher.user.name ?? undefined,
      institutionName: institution.name,
      inviteLink,
    });

    logAudit("TEACHER_INVITE_RESENT", {
      userId: user.userId,
      actorRole: user.role,
      institutionId,
      details: `Invite resent to ${teacher.user.name}`,
      metadata: { teacherId: teacher.teacherId, email: teacher.user.email },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.json({ success: true, data: { message: "Invite resent successfully" } });
  } catch (error) {
    next(error);
  }
};

export const deleteTeacher = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const teacher = await prisma.teacher.findFirst({
      where: { id, institutionId },
      select: { userId: true, user: { select: { email: true, name: true } } },
    });
    if (!teacher) throw new NotFoundError("Teacher not found");

    await prisma.$transaction(async (tx) => {
      // Remove class assignments
      await tx.divisionAssignment.deleteMany({ where: { teacherId: id } });

      // Task tests — delete dependent rows first
      const tests = await tx.taskTest.findMany({ where: { teacherId: id }, select: { id: true } });
      if (tests.length) {
        const testIds = tests.map(t => t.id);
        const attempts = await tx.taskTestAttempt.findMany({ where: { testId: { in: testIds } }, select: { id: true } });
        if (attempts.length) {
          await tx.taskStudentAnswer.deleteMany({ where: { attemptId: { in: attempts.map(a => a.id) } } });
          await tx.taskTestAttempt.deleteMany({ where: { testId: { in: testIds } } });
        }
        await tx.taskTestQuestion.deleteMany({ where: { testId: { in: testIds } } });
      }
      await tx.taskTest.deleteMany({ where: { teacherId: id } });

      // Task modules
      const modules = await tx.taskModule.findMany({ where: { teacherId: id }, select: { id: true } });
      if (modules.length) {
        await tx.taskModuleQuestion.deleteMany({ where: { moduleId: { in: modules.map(m => m.id) } } });
      }
      await tx.taskModule.deleteMany({ where: { teacherId: id } });

      // Task questions
      await tx.taskQuestion.deleteMany({ where: { teacherId: id } });

      // Blackboard
      await tx.blackboardMaterial.deleteMany({ where: { teacherId: id } });
      await tx.blackboardFolder.deleteMany({ where: { teacherId: id } });

      // PDF uploads
      await tx.taskPdfUpload.deleteMany({ where: { teacherId: id } });

      // Invalidate invites
      await tx.invite.deleteMany({ where: { email: teacher.user.email } });

      // Delete teacher and user
      await tx.teacher.delete({ where: { id } });
      await tx.user.delete({ where: { id: teacher.userId } });
    });

    logAudit("TEACHER_DELETED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId,
      details: `Teacher ${teacher.user.name} permanently deleted`,
      metadata: { email: teacher.user.email },
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const listSubAdmins = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution");

    const subAdmins = await prisma.subAdmin.findMany({
      where: { institutionId: institutionId! },
      include: { user: { omit: { password: true } } },
      orderBy: { createdAt: "desc" },
    });

    const emails = subAdmins.map(s => s.user.email);
    const pendingInvites = await prisma.invite.findMany({
      where: {
        email: { in: emails },
        role: "SUB_ADMIN",
        isUsed: false,
        expiresAt: { gte: new Date() },
      },
      select: { email: true },
    });
    const pendingSet = new Set(pendingInvites.map(i => i.email));

    res.json({
      success: true,
      data: subAdmins.map(s => ({
        id: s.id,
        userId: s.userId,
        name: s.user.name,
        email: s.user.email,
        displayId: s.user.displayId,
        isActive: s.user.isActive,
        permissions: s.permissions,
        invitePending: pendingSet.has(s.user.email),
        createdAt: s.createdAt,
        designation: s.designation,
        phone: s.phone,
        city: s.city,
        state: s.state,
        qualification: s.qualification,
        experience: s.experience,
      })),
    });
  } catch (err) {
    next(err);
  }
};

export const addSubAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution");

    const data = addSubAdminSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new BadRequestError("A user with this email already exists");

    const institution = await prisma.institution.findUnique({ where: { id: institutionId! } });
    if (!institution) throw new NotFoundError("Institution not found");

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    const subAdmin = await prisma.$transaction(async (tx) => {
      const displayId = await generateUserId(institutionId!, "A", tx);
      const newUser = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          role: "SUB_ADMIN",
          institutionId: institutionId!,
          isActive: false,
          displayId,
        },
      });

      const newSubAdmin = await tx.subAdmin.create({
        data: {
          userId: newUser.id,
          institutionId: institutionId!,
          permissions: data.permissions,
          createdById: user.userId,
          designation: data.designation,
          phone: data.phone,
          dob: data.dob,
          gender: data.gender,
          address: data.address,
          city: data.city,
          state: data.state,
          pincode: data.pincode,
          country: data.country ?? "India",
          qualification: data.qualification,
          experience: data.experience,
        },
        include: { user: { omit: { password: true } } },
      });

      await tx.invite.create({
        data: {
          email: data.email,
          tokenHash,
          role: "SUB_ADMIN",
          permissions: data.permissions,
          institutionId: institutionId!,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      return newSubAdmin;
    });

    const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
    sendSubAdminInviteEmail({
      to: data.email,
      name: data.name,
      institutionName: institution.name,
      inviteLink,
      permissions: data.permissions as string[],
    }).catch(err => console.error("SubAdmin invite email failed:", err));

    logAudit("SUBADMIN_ADDED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `${data.name} added as subadmin with permissions: ${data.permissions.join(", ")}`,
      metadata: { email: data.email, permissions: data.permissions },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.status(201).json({
      success: true,
      data: {
        id: subAdmin.id,
        name: subAdmin.user.name,
        email: subAdmin.user.email,
        permissions: subAdmin.permissions,
        isActive: subAdmin.user.isActive,
        invitePending: true,
        createdAt: subAdmin.createdAt,
        designation: subAdmin.designation,
        phone: subAdmin.phone,
        city: subAdmin.city,
        state: subAdmin.state,
        qualification: subAdmin.qualification,
        experience: subAdmin.experience,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const updateSubAdminPermissions = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution");

    const id = req.params.id as string;
    const { permissions } = updateSubAdminPermissionsSchema.parse(req.body);

    const subAdmin = await prisma.subAdmin.findFirst({
      where: { id, institutionId: institutionId! },
    });
    if (!subAdmin) throw new NotFoundError("SubAdmin not found");

    const updated = await prisma.subAdmin.update({
      where: { id },
      data: { permissions },
      select: { userId: true },
    });

    await cacheSubAdminPermissions(updated.userId, permissions);

    logAudit("SUBADMIN_PERMISSIONS_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `SubAdmin permissions updated to: ${permissions.join(", ")}`,
      metadata: { subAdminId: id, permissions },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.json({ success: true, data: { id, permissions } });
  } catch (err) {
    next(err);
  }
};

export const deactivateSubAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution");

    const id = req.params.id as string;

    const subAdmin = await prisma.subAdmin.findFirst({
      where: { id, institutionId: institutionId! },
      include: { user: true },
    });
    if (!subAdmin) throw new NotFoundError("SubAdmin not found");

    await prisma.user.update({
      where: { id: subAdmin.userId },
      data: { isActive: false },
    });

    logAudit("SUBADMIN_DEACTIVATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `SubAdmin ${subAdmin.user.email} deactivated`,
      metadata: { subAdminId: id },
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });

    res.json({ success: true, data: { message: "SubAdmin deactivated" } });
  } catch (err) {
    next(err);
  }
};

export const resendSubAdminInvite = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution");

    const id = req.params.id as string;

    const subAdmin = await prisma.subAdmin.findFirst({
      where: { id, institutionId: institutionId! },
      include: { user: true },
    });
    if (!subAdmin) throw new NotFoundError("SubAdmin not found");
    if (subAdmin.user.isActive) throw new BadRequestError("SubAdmin has already activated their account");

    const institution = await prisma.institution.findUnique({ where: { id: institutionId! } });
    if (!institution) throw new NotFoundError("Institution not found");

    await prisma.invite.updateMany({
      where: { email: subAdmin.user.email, role: "SUB_ADMIN", isUsed: false },
      data: { isUsed: true },
    });

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    await prisma.invite.create({
      data: {
        email: subAdmin.user.email,
        tokenHash,
        role: "SUB_ADMIN",
        permissions: subAdmin.permissions,
        institutionId: institutionId!,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const inviteLink = `${process.env.FRONTEND_URL}/set-password?token=${rawToken}`;
    await sendSubAdminInviteEmail({
      to: subAdmin.user.email,
      name: subAdmin.user.name ?? undefined,
      institutionName: institution.name,
      inviteLink,
      permissions: subAdmin.permissions,
    });

    logAudit("SUBADMIN_INVITE_RESENT", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `Invite resent to subadmin ${subAdmin.user.email}`,
      metadata: { subAdminId: id },
      category: "ADMIN_ACTION",
      severity: "INFO",
    });

    res.json({ success: true, data: { message: "Invite resent" } });
  } catch (err) {
    next(err);
  }
};

export const deleteSubAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user!;
    const { institutionId } = user;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const subAdmin = await prisma.subAdmin.findFirst({
      where: { id, institutionId: institutionId! },
      select: { userId: true, user: { select: { email: true, name: true } } },
    });
    if (!subAdmin) throw new NotFoundError("SubAdmin not found");

    await prisma.$transaction(async (tx) => {
      await tx.invite.deleteMany({ where: { email: subAdmin.user.email } });
      await tx.subAdmin.delete({ where: { id } });
      await tx.user.delete({ where: { id: subAdmin.userId } });
    });

    logAudit("SUBADMIN_DELETED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `SubAdmin ${subAdmin.user.name} permanently deleted`,
      metadata: { email: subAdmin.user.email },
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
