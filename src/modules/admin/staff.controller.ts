import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError, ConflictError } from "../../utils/errors";

const STAFF_TYPES = ["TEACHER", "ADMIN", "SUB_ADMIN", "HELPER", "OTHER"] as const;

const createStaffSchema = z.object({
  name: z.string().min(1).max(150).trim(),
  email: z.string().email(),
  phone: z.string().max(20).optional(),
  designation: z.string().max(100).optional(),
  staffType: z.enum(STAFF_TYPES),
  userId: z.string().optional(),
});

const updateStaffSchema = z.object({
  name: z.string().min(1).max(150).trim().optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  designation: z.string().max(100).optional(),
  staffType: z.enum(STAFF_TYPES).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const listStaff = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const staff = await academicDb().staff.findMany({
      where: { institutionId },
      include: { salaryStructure: true },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: staff });
  } catch (err) {
    next(err);
  }
};

// Users with role TEACHER/ADMIN/SUB_ADMIN not yet linked to a Staff row, matched by name/email substring.
export const searchLinkableProfiles = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    if (q.length < 2) return res.json({ success: true, data: [] });

    const linkedUserIds = (await academicDb().staff.findMany({ where: { institutionId, userId: { not: null } }, select: { userId: true } }))
      .map((s) => s.userId)
      .filter((id): id is string => !!id);

    const users = await prisma.user.findMany({
      where: {
        institutionId,
        role: { in: ["TEACHER", "ADMIN", "SUB_ADMIN"] },
        id: { notIn: linkedUserIds },
        OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }],
      },
      select: { id: true, name: true, email: true, role: true },
      take: 20,
    });
    res.json({ success: true, data: users.map((u) => ({ userId: u.id, name: u.name, email: u.email, role: u.role })) });
  } catch (err) {
    next(err);
  }
};

export const createStaff = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const data = createStaffSchema.parse(req.body);

    if (data.userId) {
      const linkedUser = await prisma.user.findFirst({ where: { id: data.userId, institutionId } });
      if (!linkedUser) throw new NotFoundError("Profile not found in this institution");

      const existing = await academicDb().staff.findFirst({ where: { userId: data.userId } });
      if (existing) throw new ConflictError("This profile is already linked to a staff record");
    }

    const staff = await academicDb().staff.create({
      data: {
        institutionId,
        name: data.name,
        email: data.email,
        phone: data.phone,
        designation: data.designation,
        staffType: data.staffType,
        userId: data.userId ?? null,
      },
    });
    res.status(201).json({ success: true, data: staff });
  } catch (err) {
    next(err);
  }
};

export const updateStaff = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;
    const data = updateStaffSchema.parse(req.body);

    const existing = await academicDb().staff.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Staff member not found");

    const updated = await academicDb().staff.update({ where: { id }, data });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

export const deleteStaff = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const id = req.params.id as string;

    const existing = await academicDb().staff.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Staff member not found");

    const payslipCount = await academicDb().payslip.count({ where: { staffId: id } });
    if (payslipCount > 0) throw new ConflictError("Cannot delete a staff member with payroll history");

    await academicDb().staffSalaryStructure.deleteMany({ where: { staffId: id } });
    await academicDb().staff.delete({ where: { id } });
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
};
