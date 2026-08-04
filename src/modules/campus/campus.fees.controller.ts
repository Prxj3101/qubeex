import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { z } from "zod";

// ── Schemas ───────────────────────────────────────────────────────────────────

const subItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  amount: z.number().min(0),
});

const feeItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  amount: z.number().min(0),
  subItems: z.array(subItemSchema),
});

const feeStructureSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  // "EVENT" kept for backward compatibility with any structures saved before
  // the frontend renamed this type to "PENALTY" (Penalty / Fine).
  type: z.enum(["REGULAR", "ADDON", "EVENT", "PENALTY", "ONE_TIME", "BUS", "LATE_FEE"]),
  color: z.string(),
  items: z.array(feeItemSchema),
  // Tracks whether this structure was created from Fee Setup's general "Add
  // Structure" button, or from a student's fee card "+" (per-student extra).
  // Lets the admin filter the Fee Structures list by source. Optional/absent
  // for structures saved before this field existed — the frontend treats a
  // missing origin as "setup" so nothing old disappears from either list.
  origin: z.enum(["setup", "student"]).optional(),
});

const feeMonthSchema = z.object({
  id: z.string(),
  month: z.string(),
  dueDate: z.string(),
  assignedStructureIds: z.array(z.string()),
  remark: z.string().optional().default(""),
});

const bankDetailsSchema = z.object({
  accountName: z.string(),
  accountNumber: z.string(),
  ifsc: z.string(),
  bankName: z.string(),
  branch: z.string(),
  upiId: z.string().optional(),
});

// Matches the frontend's `StudentDetailField` shape exactly — a default field
// (name/rollNo/studentId/class/division) or a custom one, reorderable, with an
// optional value override. Previously this schema only accepted a bare
// { label, value } shape under a different key (`extraStudentFields`), which
// didn't match what the UI actually sends (`studentFields`) and made every
// save fail validation, not just this one field.
const studentFieldSchema = z.object({
  id: z.string(),
  kind: z.enum(["default", "custom"]),
  defaultKey: z.enum(["name", "rollNo", "studentId", "class", "division", "bus"]).optional(),
  label: z.string(),
  value: z.string().optional(),
});

const ruleSchema = z.object({
  id: z.string(),
  text: z.string(),
});

const saveFeeStructureSchema = z.object({
  feeStructures: z.array(feeStructureSchema),
  feeMonths: z.array(feeMonthSchema),
  bankDetails: bankDetailsSchema.optional().nullable(),
  qrImageUrl: z.string().url().optional().nullable(),
  extraColumns: z.array(z.object({ label: z.string() })),
  studentFields: z.array(studentFieldSchema),
  generalRemark: z.string().max(2000).optional().nullable(),
  feeCardTheme: z.string().optional().nullable(),
  schoolLogoUrl: z.string().url().optional().nullable(),
  schoolName: z.string().max(150).optional().nullable(),
  rulesAndRegs: z.array(ruleSchema).optional().default([]),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireInstitution(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

// The DB column is `extraStudentFields` (kept as-is to avoid a column rename
// migration), but the frontend's request/response key is `studentFields` —
// this maps DB shape -> API shape so callers never see the column name.
function formatStructure(s: {
  id: string | null;
  divisionId: string;
  institutionId: string;
  feeStructures: unknown;
  feeMonths: unknown;
  bankDetails: unknown;
  qrImageUrl: string | null;
  extraColumns: unknown;
  extraStudentFields: unknown;
  generalRemark: string | null;
  feeCardTheme?: string | null;
  schoolLogoUrl?: string | null;
  schoolName?: string | null;
  rulesAndRegs?: unknown;
  isTemplate: boolean;
  templateFrom: string | null;
}) {
  const { extraStudentFields, ...rest } = s;
  return { ...rest, studentFields: extraStudentFields };
}

// ── Controllers ───────────────────────────────────────────────────────────────

export const getFeeStructure = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);
    const divisionId = req.params.divisionId as string;

    const division = await prisma.division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    const structure = await (prisma.divisionFeeStructure as any).findFirst({
      where: { divisionId, institutionId },
    });

    if (structure) {
      return res.json({
        success: true,
        data: formatStructure({ ...structure, isTemplate: false, templateFrom: null }),
      });
    }

    // No structure — try most recently created as template
    const template = await (prisma.divisionFeeStructure as any).findFirst({
      where: { institutionId, divisionId: { not: divisionId } },
      orderBy: { createdAt: "desc" },
      include: {
        division: {
          select: { name: true, standard: { select: { name: true } } },
        },
      },
    });

    if (template) {
      return res.json({
        success: true,
        data: {
          id: null,
          divisionId,
          institutionId,
          feeStructures: template.feeStructures,
          feeMonths: template.feeMonths,
          bankDetails: template.bankDetails,
          qrImageUrl: template.qrImageUrl,
          extraColumns: template.extraColumns,
          studentFields: template.extraStudentFields,
          generalRemark: template.generalRemark,
          // Card branding (theme/logo/school name) is deliberately NOT copied
          // from another division's template — those are specific to the
          // division whose card this is, not something to inherit.
          feeCardTheme: null,
          schoolLogoUrl: null,
          schoolName: null,
          // Rules & regs are also division-specific (fee counter timings, late
          // fee policy) — not something to carry over from another division.
          rulesAndRegs: [],
          isTemplate: true,
          templateFrom: `${template.division.standard.name} ${template.division.name}`,
          createdAt: null,
          updatedAt: null,
        },
      });
    }

    res.json({ success: true, data: null });
  } catch (err) {
    next(err);
  }
};

export const saveFeeStructure = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);
    const divisionId = req.params.divisionId as string;

    const division = await prisma.division.findFirst({ where: { id: divisionId, institutionId } });
    if (!division) throw new NotFoundError("Division not found");

    const data = saveFeeStructureSchema.parse(req.body);

    const structure = await (prisma.divisionFeeStructure as any).upsert({
      where: { divisionId },
      create: {
        divisionId,
        institutionId,
        feeStructures: data.feeStructures,
        feeMonths: data.feeMonths,
        bankDetails: data.bankDetails ?? undefined,
        qrImageUrl: data.qrImageUrl ?? null,
        extraColumns: data.extraColumns,
        extraStudentFields: data.studentFields,
        generalRemark: data.generalRemark ?? null,
        feeCardTheme: data.feeCardTheme ?? null,
        schoolLogoUrl: data.schoolLogoUrl ?? null,
        schoolName: data.schoolName ?? null,
        rulesAndRegs: data.rulesAndRegs,
      },
      update: {
        feeStructures: data.feeStructures,
        feeMonths: data.feeMonths,
        bankDetails: data.bankDetails ?? undefined,
        qrImageUrl: data.qrImageUrl ?? null,
        extraColumns: data.extraColumns,
        extraStudentFields: data.studentFields,
        generalRemark: data.generalRemark ?? null,
        feeCardTheme: data.feeCardTheme ?? null,
        schoolLogoUrl: data.schoolLogoUrl ?? null,
        schoolName: data.schoolName ?? null,
        rulesAndRegs: data.rulesAndRegs,
      },
    });

    res.json({
      success: true,
      data: formatStructure({ ...structure, isTemplate: false, templateFrom: null }),
    });
  } catch (err) {
    next(err);
  }
};
