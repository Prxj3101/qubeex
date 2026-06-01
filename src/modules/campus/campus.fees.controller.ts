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
  type: z.enum(["REGULAR", "ADDON", "EVENT", "ONE_TIME"]),
  color: z.string(),
  items: z.array(feeItemSchema),
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

const saveFeeStructureSchema = z.object({
  feeStructures: z.array(feeStructureSchema),
  feeMonths: z.array(feeMonthSchema),
  bankDetails: bankDetailsSchema.optional().nullable(),
  qrImageUrl: z.string().url().optional().nullable(),
  extraColumns: z.array(z.object({ label: z.string() })),
  extraStudentFields: z.array(z.object({ label: z.string(), value: z.string() })),
  generalRemark: z.string().max(2000).optional().nullable(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireInstitution(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

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
  isTemplate: boolean;
  templateFrom: string | null;
}) {
  return s;
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
          extraStudentFields: template.extraStudentFields,
          generalRemark: template.generalRemark,
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
        extraStudentFields: data.extraStudentFields,
        generalRemark: data.generalRemark ?? null,
      },
      update: {
        feeStructures: data.feeStructures,
        feeMonths: data.feeMonths,
        bankDetails: data.bankDetails ?? undefined,
        qrImageUrl: data.qrImageUrl ?? null,
        extraColumns: data.extraColumns,
        extraStudentFields: data.extraStudentFields,
        generalRemark: data.generalRemark ?? null,
      },
    });

    res.json({
      success: true,
      data: { ...structure, isTemplate: false, templateFrom: null },
    });
  } catch (err) {
    next(err);
  }
};
