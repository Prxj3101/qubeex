import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError, ConflictError } from "../../utils/errors";
import { calculateSalary, structureForMonth, StructureItem } from "../../services/payrollCalc.service";
import { loadComponents, loadPayrollSettings, readStaffBankDetails, writeStaffBankDetails, loadLinkedProfiles } from "../../services/payrollData.service";

const STAFF_TYPES = ["TEACHER", "ADMIN", "SUB_ADMIN", "HELPER", "OTHER"] as const;
const PAYMENT_MODES = ["BANK", "CASH", "CHEQUE"] as const;

const bankDetailsSchema = z.object({
  accountName: z.string().max(150),
  accountNumber: z.string().max(34),
  ifsc: z.string().max(11),
  bankName: z.string().max(150),
});

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "must be a date (YYYY-MM-DD)");
// Joining date is optional: "" / null = long-time staff (full salary, no proration).
const optionalDate = z.union([dateOnly, z.literal("")]).nullable().optional();
const toDateOnly = (s: string): Date => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

// Email is optional (payroll-only staff often have none). "" is stored as null.
const optionalEmail = z.union([z.string().trim().email(), z.literal("")]).nullable().optional()
  .transform((v) => (v === "" ? null : v));

// Optional text fields: "" from a cleared form input is stored as null.
const optionalText = (max: number) => z.string().max(max).trim().optional().transform((v) => (v === "" ? null : v));

const createStaffSchema = z.object({
  name: z.string().min(1).max(150).trim(),
  email: optionalEmail,
  phone: optionalText(20),
  designation: optionalText(100),
  staffType: z.enum(STAFF_TYPES),
  userId: z.string().optional(),
  employeeCode: optionalText(40),
  joinedAt: optionalDate,
  pan: optionalText(10),
  uan: optionalText(12),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
  bankDetails: bankDetailsSchema.nullable().optional(),
});

const updateStaffSchema = z.object({
  name: z.string().min(1).max(150).trim().optional(),
  email: optionalEmail,
  phone: optionalText(20),
  designation: optionalText(100),
  staffType: z.enum(STAFF_TYPES).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  employeeCode: optionalText(40),
  joinedAt: optionalDate,
  exitDate: dateOnly.nullable().optional(),
  pan: optionalText(10),
  uan: optionalText(12),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
  bankDetails: bankDetailsSchema.nullable().optional(),
});

// Never send the encrypted blob to the client — send the readable details.
function presentStaff<T extends { bankDetails: string | null }>(s: T) {
  const { bankDetails, ...rest } = s;
  return { ...rest, bankDetails: readStaffBankDetails(bankDetails) };
}

export const listStaff = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const month = new Date().toISOString().slice(0, 7);
    const [staff, structures, components, settings] = await Promise.all([
      academicDb().staff.findMany({ where: { institutionId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
      academicDb().staffSalaryStructure.findMany({ where: { institutionId } }),
      loadComponents(institutionId),
      loadPayrollSettings(institutionId),
    ]);

    const byStaff = new Map<string, typeof structures>();
    for (const s of structures) {
      const list = byStaff.get(s.staffId) ?? [];
      list.push(s);
      byStaff.set(s.staffId, list);
    }

    const profiles = await loadLinkedProfiles(institutionId, staff.map((s) => s.userId).filter((id): id is string => !!id));

    const data = staff.map((s) => {
      const profile = s.userId ? profiles.get(s.userId) : undefined;
      const current = structureForMonth(byStaff.get(s.id) ?? [], month) ?? null;
      // Full-month salary (no LOP / joining proration) — what the person
      // earns in a normal month on their current structure.
      const monthly = current
        ? calculateSalary({ month, items: current.items as unknown as StructureItem[], components, dayBasis: settings.dayBasis })
        : null;
      return {
        ...presentStaff(s),
        // From the linked QubeEx profile (teacher / sub-admin / admin); payroll-only staff have none.
        avatarUrl: profile?.avatarUrl ?? null,
        profileDesignation: profile?.designation ?? null,
        salaryStructure: current,
        monthlySalary: monthly
          ? { grossPay: monthly.grossPay, netPay: monthly.netPay, earnings: monthly.earnings, deductions: monthly.deductions }
          : null,
        salaryVersions: (byStaff.get(s.id) ?? []).length,
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// Next position at the end of the list (new staff are added at the bottom).
async function nextSortOrder(institutionId: string): Promise<number> {
  const last = await academicDb().staff.findFirst({ where: { institutionId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  return (last?.sortOrder ?? -1) + 1;
}

// One-click "Import all": adds every ACTIVE teacher / admin / sub-admin of the
// institution that isn't on payroll yet as a linked Staff row, with no joining
// date (= already on staff, full salary).
export const importLinkableProfiles = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");

    const linkedUserIds = (await academicDb().staff.findMany({ where: { institutionId, userId: { not: null } }, select: { userId: true } }))
      .map((s) => s.userId)
      .filter((id): id is string => !!id);

    const users = await prisma.user.findMany({
      where: { institutionId, isActive: true, role: { in: ["TEACHER", "ADMIN", "SUB_ADMIN"] }, id: { notIn: linkedUserIds } },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    });
    if (users.length === 0) return res.json({ success: true, data: { count: 0, names: [] } });

    const teachers = await academicDb().teacher.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { userId: true, phone: true },
    });
    const teacherByUser = new Map(teachers.map((t) => [t.userId, t]));

    const start = await nextSortOrder(institutionId);
    await academicDb().staff.createMany({
      data: users.map((u, i) => {
        const t = teacherByUser.get(u.id);
        return {
          institutionId,
          name: u.name?.trim() || u.email,
          email: u.email,
          phone: t?.phone ?? null,
          staffType: u.role,
          userId: u.id,
          sortOrder: start + i,
          // No joining date on import: these people are already working at
          // the school (their QubeEx sign-up date says nothing about that).
        };
      }),
      skipDuplicates: true,
    });

    res.json({ success: true, data: { count: users.length, names: users.map((u) => u.name?.trim() || u.email) } });
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

    const sortOrder = await nextSortOrder(institutionId);
    const staff = await academicDb().staff.create({
      data: {
        institutionId,
        sortOrder,
        name: data.name,
        email: data.email ?? null,
        phone: data.phone ?? null,
        designation: data.designation ?? null,
        staffType: data.staffType,
        userId: data.userId ?? null,
        employeeCode: data.employeeCode ?? null,
        pan: data.pan ? data.pan.toUpperCase() : null,
        uan: data.uan ?? null,
        paymentMode: data.paymentMode ?? "BANK",
        bankDetails: writeStaffBankDetails(data.bankDetails ?? null),
        joinedAt: data.joinedAt ? toDateOnly(data.joinedAt) : null,
      },
    });
    res.status(201).json({ success: true, data: presentStaff(staff) });
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

    const { bankDetails, joinedAt, exitDate, pan, ...rest } = data;
    const joined = joinedAt === undefined ? existing.joinedAt : joinedAt ? toDateOnly(joinedAt) : null;
    const exit = exitDate === undefined ? existing.exitDate : exitDate === null ? null : toDateOnly(exitDate);
    if (exit && joined && exit < joined) throw new BadRequestError("Exit date can't be before the joining date");

    const updated = await academicDb().staff.update({
      where: { id },
      data: {
        ...rest,
        ...(pan !== undefined ? { pan: pan ? pan.toUpperCase() : null } : {}),
        ...(joinedAt !== undefined ? { joinedAt: joined } : {}),
        ...(exitDate !== undefined ? { exitDate: exit } : {}),
        ...(bankDetails !== undefined ? { bankDetails: writeStaffBankDetails(bankDetails) } : {}),
      },
    });
    res.json({ success: true, data: presentStaff(updated) });
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
    if (payslipCount > 0) throw new ConflictError("This staff member has payslip history. Mark them inactive instead of deleting.");

    await academicDb().staffSalaryStructure.deleteMany({ where: { staffId: id } });
    await academicDb().staff.delete({ where: { id } });
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
};

// Save the drag-and-drop order: body { ids: [...] } = every staff id in the new order.
const reorderSchema = z.object({ ids: z.array(z.string()).min(1).max(2000) });

export const reorderStaff = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = req.user!;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const { ids } = reorderSchema.parse(req.body);

    const owned = await academicDb().staff.findMany({ where: { institutionId, id: { in: ids } }, select: { id: true } });
    if (owned.length !== new Set(ids).size) throw new BadRequestError("Some staff members were not found");

    await academicDb().$transaction(ids.map((id, index) => academicDb().staff.update({ where: { id }, data: { sortOrder: index } })));
    res.json({ success: true, data: { count: ids.length } });
  } catch (err) {
    next(err);
  }
};
