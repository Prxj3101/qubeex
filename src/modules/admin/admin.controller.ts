import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { checkInstitutionAccess } from "../../utils/authorization";
import { uploadImageToSupabase } from "../../services/storage.service";
import { logAudit } from "../../services/audit.service";
import { NotFoundError, BadRequestError } from "../../utils/errors";
import { generateToken, hashToken } from "../../utils/token";
import { sendTeacherInviteEmail } from "../../services/email.service";
import { z } from "zod";

const updateInstitutionSchema = z.object({
  name: z.string().min(2).max(200).trim().optional(),
  email: z.string().email().max(255).toLowerCase().trim().optional(),
  phone: z.string().max(20).trim().optional().nullable(),
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

    res.json({ success: true, data: institution });
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

    await logAudit("INSTITUTION_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institution.id,
      details: `${institution.name} details updated`,
      metadata: { email: institution.email },
    });

    res.json({ success: true, data: institution });
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

    await logAudit("INSTITUTION_LOGO_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institution.id,
      details: `${institution.name} logo updated`,
      metadata: { path: uploaded.path, logoUrl: uploaded.publicUrl },
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

    const data = teachers.map((t) => ({
      id: t.id,
      teacherId: t.teacherId,
      name: t.user.name,
      email: t.user.email,
      phone: t.phone,
      avatarUrl: t.avatarUrl,
      status: t.status,
      joinedAt: t.joinedAt.toISOString(),
      assignments: [],
      experience: t.experience,
      city: t.city,
      state: t.state,
      qualification: t.qualification,
      dob: t.dob,
      gender: t.gender,
      address: t.address,
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
      const count = await tx.teacher.count({ where: { institutionId: institutionId! } });
      const teacherId = `TCH-${String(count + 1).padStart(3, "0")}`;

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

    await logAudit("TEACHER_ADDED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `${data.name} added as teacher`,
      metadata: { teacherId: teacher.teacherId, email: data.email },
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
        joinedAt: teacher.joinedAt.toISOString(),
        assignments: [],
        experience: teacher.experience,
        city: teacher.city,
        state: teacher.state,
        qualification: teacher.qualification,
        dob: teacher.dob,
        gender: teacher.gender,
        address: teacher.address,
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

    await logAudit("TEACHER_UPDATED", {
      userId: user.userId,
      actorRole: user.role,
      institutionId: institutionId!,
      details: `Teacher ${teacher.user.name} updated`,
      metadata: { teacherId: teacher.teacherId, changes: Object.keys(data) },
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
