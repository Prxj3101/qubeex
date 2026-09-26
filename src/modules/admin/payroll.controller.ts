import { Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb, runWithAcademicClient } from "../../utils/academicContext";
import { BadRequestError, NotFoundError, ConflictError } from "../../utils/errors";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2 } from "../../services/storage.service";
import { generatePayslipPdf } from "../../services/payslipPdf.service";
import { sendPayslipEmail } from "../../services/email.service";
import { createNotification } from "../../services/notification.service";
import {
  calculateSalary,
  structureForMonth,
  CalcType,
  ComponentType,
  StructureItem,
} from "../../services/payrollCalc.service";
import { loadComponents, loadPayrollSettings, readStaffBankDetails, loadLinkedProfiles } from "../../services/payrollData.service";
import { generatePayrollAiSummary, reviewHash } from "../../services/payrollAiReview.service";

// All money in this module is integer PAISE. Percentages are basis points.

// Plain-JSON copy for Prisma Json columns (typed interfaces aren't accepted
// as InputJsonValue directly).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJson = (v: unknown): any => JSON.parse(JSON.stringify(v));

const requireInstitution = (req: AuthRequest): string => {
  const { institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return institutionId;
};

// ── Settings ──────────────────────────────────────────────────────────────────

const DAY_BASIS = ["CALENDAR", "FIXED_30", "FIXED_26"] as const;

export const getPayrollSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    res.json({ success: true, data: await loadPayrollSettings(institutionId) });
  } catch (err) {
    next(err);
  }
};

const settingsSchema = z.object({
  dayBasis: z.enum(DAY_BASIS),
  payDay: z.number().int().min(1).max(28),
});

export const savePayrollSettings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const data = settingsSchema.parse(req.body);
    const saved = await academicDb().payrollSettings.upsert({
      where: { institutionId },
      create: { institutionId, ...data },
      update: data,
    });
    res.json({ success: true, data: { dayBasis: saved.dayBasis, payDay: saved.payDay } });
  } catch (err) {
    next(err);
  }
};

// ── Salary components ─────────────────────────────────────────────────────────

const COMPONENT_TYPES = ["EARNING", "DEDUCTION"] as const;
const CALC_TYPES = ["FIXED", "PERCENT_OF_BASIC"] as const;

export const listSalaryComponents = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const components = await academicDb().salaryComponent.findMany({
      where: { institutionId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json({ success: true, data: components });
  } catch (err) {
    next(err);
  }
};

const componentSchema = z
  .object({
    name: z.string().min(1).max(60).trim(),
    type: z.enum(COMPONENT_TYPES),
    calcType: z.enum(CALC_TYPES),
    isBasic: z.boolean().optional().default(false),
    lopApplicable: z.boolean().optional().default(true),
    defaultValue: z.number().int().min(0).optional().default(0),
    sortOrder: z.number().int().optional(),
  })
  .refine((c) => !(c.isBasic && (c.type !== "EARNING" || c.calcType !== "FIXED")), {
    message: "Basic must be a fixed-amount earning",
  })
  .refine((c) => !(c.calcType === "PERCENT_OF_BASIC" && c.defaultValue > 100000), {
    message: "Percentage cannot be more than 1000%",
  });

async function assertSingleBasic(institutionId: string, excludeId?: string) {
  const existing = await academicDb().salaryComponent.findFirst({
    where: { institutionId, isBasic: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (existing) throw new ConflictError(`"${existing.name}" is already set as Basic`);
}

export const createSalaryComponent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const data = componentSchema.parse(req.body);

    const dup = await academicDb().salaryComponent.findFirst({ where: { institutionId, name: data.name } });
    if (dup) throw new ConflictError(`A component named "${data.name}" already exists`);
    if (data.isBasic) await assertSingleBasic(institutionId);

    const count = await academicDb().salaryComponent.count({ where: { institutionId } });
    const created = await academicDb().salaryComponent.create({
      data: { institutionId, ...data, sortOrder: data.sortOrder ?? count },
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
};

export const updateSalaryComponent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;
    const data = componentSchema.parse(req.body);

    const existing = await academicDb().salaryComponent.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Salary component not found");
    const dup = await academicDb().salaryComponent.findFirst({ where: { institutionId, name: data.name, id: { not: id } } });
    if (dup) throw new ConflictError(`A component named "${data.name}" already exists`);
    if (data.isBasic) await assertSingleBasic(institutionId, id);

    const updated = await academicDb().salaryComponent.update({
      where: { id },
      data: { ...data, sortOrder: data.sortOrder ?? existing.sortOrder },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

const itemsUseComponent = (items: unknown, componentId: string): boolean =>
  Array.isArray(items) && items.some((i) => (i as StructureItem)?.componentId === componentId);

export const deleteSalaryComponent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;

    const existing = await academicDb().salaryComponent.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Salary component not found");

    const [structures, templates] = await Promise.all([
      academicDb().staffSalaryStructure.findMany({ where: { institutionId }, select: { items: true } }),
      academicDb().salaryTemplate.findMany({ where: { institutionId }, select: { items: true } }),
    ]);
    if (structures.some((s) => itemsUseComponent(s.items, id)) || templates.some((t) => itemsUseComponent(t.items, id))) {
      throw new ConflictError("This component is used in a staff salary or template. Remove it from there first.");
    }

    await academicDb().salaryComponent.delete({ where: { id } });
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
};

// One-click starter set so a school isn't staring at an empty screen.
const DEFAULT_COMPONENTS: Array<{
  name: string; type: ComponentType; calcType: CalcType; isBasic?: boolean; lopApplicable: boolean; defaultValue: number;
}> = [
  { name: "Basic", type: "EARNING", calcType: "FIXED", isBasic: true, lopApplicable: true, defaultValue: 0 },
  { name: "HRA", type: "EARNING", calcType: "PERCENT_OF_BASIC", lopApplicable: true, defaultValue: 4000 },
  { name: "Dearness Allowance", type: "EARNING", calcType: "PERCENT_OF_BASIC", lopApplicable: true, defaultValue: 0 },
  { name: "Transport Allowance", type: "EARNING", calcType: "FIXED", lopApplicable: false, defaultValue: 0 },
  { name: "Special Allowance", type: "EARNING", calcType: "FIXED", lopApplicable: true, defaultValue: 0 },
  { name: "Professional Tax", type: "DEDUCTION", calcType: "FIXED", lopApplicable: false, defaultValue: 20000 },
];

export const addDefaultSalaryComponents = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const existing = await academicDb().salaryComponent.findMany({ where: { institutionId } });
    const names = new Set(existing.map((c) => c.name.toLowerCase()));
    const hasBasic = existing.some((c) => c.isBasic);

    let order = existing.length;
    const toCreate = DEFAULT_COMPONENTS
      .filter((c) => !names.has(c.name.toLowerCase()))
      .map((c) => ({ ...c, isBasic: !!c.isBasic && !hasBasic, institutionId, sortOrder: order++ }));

    if (toCreate.length > 0) await academicDb().salaryComponent.createMany({ data: toCreate });
    const all = await academicDb().salaryComponent.findMany({
      where: { institutionId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json({ success: true, data: all, added: toCreate.length });
  } catch (err) {
    next(err);
  }
};

// ── Shared: structure items validation ────────────────────────────────────────

const itemSchema = z.object({
  componentId: z.string().min(1),
  value: z.number().int().min(0),
});
const itemsSchema = z.array(itemSchema);

async function validateItems(institutionId: string, items: StructureItem[]): Promise<StructureItem[]> {
  const components = await loadComponents(institutionId);
  const byId = new Map(components.map((c) => [c.id, c]));
  const seen = new Set<string>();
  for (const it of items) {
    const comp = byId.get(it.componentId);
    if (!comp) throw new BadRequestError("One of the selected components no longer exists");
    if (seen.has(it.componentId)) throw new BadRequestError(`"${comp.name}" is added twice`);
    seen.add(it.componentId);
  }
  const usesPercent = items.some((it) => byId.get(it.componentId)?.calcType === "PERCENT_OF_BASIC");
  const hasBasic = items.some((it) => byId.get(it.componentId)?.isBasic);
  if (usesPercent && !hasBasic) {
    throw new BadRequestError("Add Basic too - percentage components are calculated from Basic");
  }
  return items;
}

// ── Templates ─────────────────────────────────────────────────────────────────

const saveSalaryTemplateSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  items: itemsSchema,
});

export const listSalaryTemplates = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const templates = await academicDb().salaryTemplate.findMany({
      where: { institutionId },
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
};

export const createSalaryTemplate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const data = saveSalaryTemplateSchema.parse(req.body);

    const existing = await academicDb().salaryTemplate.findFirst({ where: { institutionId, name: data.name } });
    if (existing) throw new ConflictError(`A template named "${data.name}" already exists`);
    const items = await validateItems(institutionId, data.items);

    const template = await academicDb().salaryTemplate.create({
      data: { institutionId, name: data.name, items: toJson(items) },
    });
    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
};

export const updateSalaryTemplate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;
    const data = saveSalaryTemplateSchema.parse(req.body);

    const existing = await academicDb().salaryTemplate.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Salary template not found");
    const dup = await academicDb().salaryTemplate.findFirst({ where: { institutionId, name: data.name, id: { not: id } } });
    if (dup) throw new ConflictError(`A template named "${data.name}" already exists`);
    const items = await validateItems(institutionId, data.items);

    const updated = await academicDb().salaryTemplate.update({
      where: { id },
      data: { name: data.name, items: toJson(items) },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

export const deleteSalaryTemplate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;

    const existing = await academicDb().salaryTemplate.findFirst({ where: { id, institutionId } });
    if (!existing) throw new NotFoundError("Salary template not found");

    await academicDb().salaryTemplate.delete({ where: { id } });
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
};

// ── Staff salary structure (versioned) ────────────────────────────────────────

const saveStaffSalaryStructureSchema = z.object({
  templateId: z.string().nullable().optional(),
  items: itemsSchema,
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "effectiveFrom must be a date (YYYY-MM-DD)"),
  note: z.string().max(200).trim().optional(),
});

// Date-only → midnight UTC, so "2026-04-01" is the same day everywhere.
const toDateOnly = (s: string): Date => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

export const getStaffSalaryStructure = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const staffId = req.params.staffId as string;

    const staff = await academicDb().staff.findFirst({ where: { id: staffId, institutionId } });
    if (!staff) throw new NotFoundError("Staff member not found");

    const history = await academicDb().staffSalaryStructure.findMany({
      where: { staffId, institutionId },
      orderBy: { effectiveFrom: "desc" },
    });
    const current = structureForMonth(history, currentMonth()) ?? null;
    res.json({ success: true, data: { current, history } });
  } catch (err) {
    next(err);
  }
};

// Saves a new salary version. Re-saving the SAME effective date edits that
// version in place (fixing a typo shouldn't create history noise).
export const saveStaffSalaryStructure = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const staffId = req.params.staffId as string;
    const data = saveStaffSalaryStructureSchema.parse(req.body);

    const staff = await academicDb().staff.findFirst({ where: { id: staffId, institutionId } });
    if (!staff) throw new NotFoundError("Staff member not found");
    const items = await validateItems(institutionId, data.items);
    if (items.length === 0) throw new BadRequestError("Add at least one salary component");

    const effectiveFrom = toDateOnly(data.effectiveFrom);
    const payload = { templateId: data.templateId ?? null, items: toJson(items), note: data.note ?? null };

    const sameDay = await academicDb().staffSalaryStructure.findFirst({ where: { staffId, institutionId, effectiveFrom } });
    const structure = sameDay
      ? await academicDb().staffSalaryStructure.update({ where: { id: sameDay.id }, data: payload })
      : await academicDb().staffSalaryStructure.create({ data: { staffId, institutionId, effectiveFrom, ...payload } });

    res.json({ success: true, data: structure });
  } catch (err) {
    next(err);
  }
};

export const deleteStaffSalaryVersion = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const staffId = req.params.staffId as string;
    const versionId = req.params.versionId as string;

    const version = await academicDb().staffSalaryStructure.findFirst({ where: { id: versionId, staffId, institutionId } });
    if (!version) throw new NotFoundError("Salary version not found");

    await academicDb().staffSalaryStructure.delete({ where: { id: versionId } });
    res.json({ success: true, data: { id: versionId } });
  } catch (err) {
    next(err);
  }
};

// ── Payroll runs ──────────────────────────────────────────────────────────────

const monthSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
});

type LineItem = { label: string; amount: number };

function sumLineItems(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.amount, 0);
}

export const listPayrollRuns = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const runs = await academicDb().payrollRun.findMany({
      where: { institutionId },
      orderBy: { month: "desc" },
      include: { payslips: { select: { netPay: true, status: true } } },
    });
    res.json({
      success: true,
      data: runs.map(({ payslips, ...run }) => ({
        ...run,
        staffCount: payslips.length,
        totalNetPay: payslips.reduce((s, p) => s + p.netPay, 0),
        paidCount: payslips.filter((p) => p.status === "PAID").length,
      })),
    });
  } catch (err) {
    next(err);
  }
};

export const createPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { month } = monthSchema.parse(req.body);

    const existing = await academicDb().payrollRun.findFirst({ where: { institutionId, month } });
    if (existing) throw new ConflictError(`A payroll run for ${month} already exists`);

    const [components, settings, staffList, structures] = await Promise.all([
      loadComponents(institutionId),
      loadPayrollSettings(institutionId),
      academicDb().staff.findMany({
        where: { institutionId, status: "ACTIVE" },
        select: { id: true, name: true, email: true, joinedAt: true, exitDate: true },
      }),
      academicDb().staffSalaryStructure.findMany({ where: { institutionId } }),
    ]);

    const structuresByStaff = new Map<string, typeof structures>();
    for (const s of structures) {
      const list = structuresByStaff.get(s.staffId) ?? [];
      list.push(s);
      structuresByStaff.set(s.staffId, list);
    }

    const run = await academicDb().$transaction(async (tx) => {
      const createdRun = await tx.payrollRun.create({ data: { institutionId, month, status: "DRAFT" } });

      for (const staff of staffList) {
        const structure = structureForMonth(structuresByStaff.get(staff.id) ?? [], month);
        if (!structure) continue;
        const result = calculateSalary({
          month,
          items: structure.items as unknown as StructureItem[],
          components,
          dayBasis: settings.dayBasis,
          lopDays: 0,
          joinedAt: staff.joinedAt,
          exitDate: staff.exitDate,
        });
        if (result.employedDays === 0) continue; // not on the rolls this month

        await tx.payslip.create({
          data: {
            payrollRunId: createdRun.id, staffId: staff.id, institutionId,
            staffName: staff.name, staffEmail: staff.email,
            earnings: toJson(result.earnings), deductions: toJson(result.deductions),
            grossPay: result.grossPay, netPay: result.netPay,
            lopDays: result.lopDays, paidDays: result.paidDays, basisDays: result.basisDays,
          },
        });
      }

      return createdRun;
    });

    res.status(201).json({ success: true, data: run });
  } catch (err) {
    next(err);
  }
};

const DRAFT_ONLY = "Changes are only allowed while the payroll is a draft. Ask the admin to send it back first.";

type RunWarning = { type: string; level: "critical" | "warning" | "info"; message: string; staffIds?: string[] };

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

// Rule-based checks of a payroll, shown in "AI Review" to the accountant (while
// preparing) and the admin (while approving). No AI here: every check is exact,
// instant and free. Three levels:
//   critical - fix before paying (red)     warning - please check (amber)     info - for your eyes (grey)
// One line per person so the message can carry the actual numbers. The AI only
// writes a short summary of these (see aiReviewPayrollRun).
const T = {
  lopWarnDays: 2, // more than 2 LOP days -> warning
  bonusWarnPct: 5, bonusCritPct: 50, // bonus as % of monthly gross
  dedWarnPct: 5, dedCritPct: 30, // extra deduction as % of monthly gross
  changeWarnPct: 10, changeCritPct: 30, // take-home change vs last month
  lowPayWarn: 0.8, lowPayCrit: 0.5, // take-home below this share of the usual take-home
  highPayWarn: 1.2, // take-home above usual (without bonus)
  roleWarnPct: 25, roleCritPct: 50, // monthly salary vs others in the same role
  cashWarnPaise: 20_000_00, // cash salary above ₹20,000
  panAnnualPaise: 5_00_000_00, // no PAN while yearly gross is above ₹5,00,000
};

async function buildRunReview(
  institutionId: string,
  run: { id: string; month: string },
  payslips: { staffId: string; staffName: string; netPay: number; grossPay: number; paidDays: number; basisDays: number; lopDays: number; bonus: number; otherDeduction: number; inputNote?: string | null; deductions?: unknown }[],
  staffList: { id: string; paymentMode: string; bankDetails: string | null }[],
) {
  const warnings: RunWarning[] = [];
  const add = (w: RunWarning) => warnings.push(w);
  const staffById = new Map(staffList.map((s) => [s.id, s]));

  const [active, structures, details, components, settings] = await Promise.all([
    academicDb().staff.findMany({ where: { institutionId, status: "ACTIVE" }, select: { id: true, name: true, joinedAt: true } }),
    academicDb().staffSalaryStructure.findMany({ where: { institutionId } }),
    academicDb().staff.findMany({
      where: { id: { in: payslips.map((p) => p.staffId) } },
      select: { id: true, designation: true, staffType: true, joinedAt: true, exitDate: true, status: true, email: true, phone: true, pan: true },
    }),
    loadComponents(institutionId),
    loadPayrollSettings(institutionId),
  ]);
  const detailOf = new Map(details.map((d) => [d.id, d]));
  const inMonth = (d: Date | null | undefined) => !!d && d.toISOString().slice(0, 7) === run.month;
  const pctOf = (part: number, whole: number) => Math.round((part / whole) * 100);

  // Normal full-month salary (no LOP, no joining proration, no bonus) of each person, to compare against.
  const normal = new Map<string, { gross: number; net: number }>();
  for (const p of payslips) {
    const st = structureForMonth(structures.filter((x) => x.staffId === p.staffId), run.month);
    if (!st) continue;
    const r = calculateSalary({ month: run.month, items: st.items as unknown as StructureItem[], components, dayBasis: settings.dayBasis });
    normal.set(p.staffId, { gross: r.grossPay, net: r.netPay });
  }

  // Same bank account used by two people = mistake or fraud.
  const byAccount = new Map<string, string[]>();
  for (const p of payslips) {
    const s = staffById.get(p.staffId);
    if (s?.paymentMode !== "BANK") continue;
    const b = readStaffBankDetails(s.bankDetails);
    if (!b?.accountNumber) continue;
    const key = `${b.accountNumber.replace(/\s/g, "")}|${(b.ifsc || "").toUpperCase()}`;
    byAccount.set(key, [...(byAccount.get(key) ?? []), p.staffName]);
  }
  for (const names of byAccount.values()) {
    if (names.length > 1) add({ type: "SHARED_ACCOUNT", level: "critical", message: `${names.join(" and ")} have the same bank account. Check the bank details before paying.` });
  }

  for (const p of payslips) {
    const s = staffById.get(p.staffId);
    const d = detailOf.get(p.staffId);
    const n = normal.get(p.staffId);
    const joined = inMonth(d?.joinedAt);
    const left = inMonth(d?.exitDate);
    const ids = [p.staffId];
    const note = p.inputNote ? ` (${p.inputNote})` : "";
    const lopLine = (Array.isArray(p.deductions) ? (p.deductions as { label: string; amount: number }[]) : []).find((l) => l.label.startsWith("Loss of Pay"));

    // Paying at all
    if (s?.paymentMode === "BANK" && !s.bankDetails) add({ type: "NO_BANK", level: "critical", staffIds: ids,
      message: `${p.staffName} is paid by bank transfer but has no bank details saved, so the salary can't be sent.` });
    if (p.netPay <= 0) add({ type: "ZERO_PAY", level: "critical", staffIds: ids, message: `${p.staffName}'s take-home is ${inr(p.netPay)}.` });
    if (d?.status === "INACTIVE") add({ type: "INACTIVE", level: "warning", staffIds: ids, message: `${p.staffName} is marked inactive but is still in this payroll.` });
    if (s?.paymentMode === "CASH" && p.netPay > T.cashWarnPaise) add({ type: "BIG_CASH", level: "warning", staffIds: ids,
      message: `${p.staffName} is paid ${inr(p.netPay)} in cash. Large cash salaries are better paid by bank for a proper record.` });

    // Bonus / extra deduction (every one is listed; large ones are flagged)
    if (p.bonus > 0) {
      const pct = n && n.gross > 0 ? pctOf(p.bonus, n.gross) : null;
      const level = pct === null ? "warning" : pct > T.bonusCritPct ? "critical" : pct > T.bonusWarnPct ? "warning" : "info";
      add({ type: "BONUS", level, staffIds: ids,
        message: `${p.staffName} gets a bonus of ${inr(p.bonus)}${note}${pct !== null ? `, ${pct}% of their monthly salary (${inr(n!.gross)})` : ""}.` +
          (n && p.bonus >= n.gross ? " Check it isn't a typing mistake (an extra zero)." : "") +
          (!p.inputNote && level !== "info" ? " Add a note saying why, for the record." : "") });
    }
    if (p.otherDeduction > 0) {
      const pct = n && n.gross > 0 ? pctOf(p.otherDeduction, n.gross) : null;
      const level = pct === null ? "warning" : pct > T.dedCritPct ? "critical" : pct > T.dedWarnPct ? "warning" : "info";
      add({ type: "DEDUCTION", level, staffIds: ids,
        message: `${p.staffName} has an extra deduction of ${inr(p.otherDeduction)}${note}${pct !== null ? `, ${pct}% of their monthly salary` : ""}.` +
          (!p.inputNote && level !== "info" ? " Add a note saying why, for the record." : "") });
    }

    // Leave
    if (p.lopDays > 0) {
      const heavy = p.lopDays > p.basisDays / 2;
      const level = heavy ? "critical" : p.lopDays > T.lopWarnDays ? "warning" : "info";
      add({ type: "LOP", level, staffIds: ids,
        message: `${p.staffName} has ${p.lopDays} LOP day${p.lopDays === 1 ? "" : "s"}${lopLine ? ` (${inr(lopLine.amount)} cut)` : ""}${heavy ? ", so most of the salary is cut" : ""}.` });
      if (joined) add({ type: "LOP_NEW_JOINER", level: "warning", staffIds: ids,
        message: `${p.staffName} joined this month and also has LOP. The days before joining are already unpaid, so make sure they aren't counted twice.` });
    }

    // Take-home compared with the usual month
    if (n && n.net > 0 && p.netPay > 0 && !joined && !left) {
      const share = p.netPay / n.net;
      if (share < T.lowPayCrit) add({ type: "LOW_PAY", level: "critical", staffIds: ids,
        message: `${p.staffName}'s take-home ${inr(p.netPay)} is less than half their usual ${inr(n.net)}.` });
      else if (share < T.lowPayWarn && p.lopDays <= T.lopWarnDays) add({ type: "LOW_PAY", level: "warning", staffIds: ids,
        message: `${p.staffName}'s take-home ${inr(p.netPay)} is ${100 - Math.round(share * 100)}% below their usual ${inr(n.net)}.` });
      if (p.netPay - p.bonus > n.net * T.highPayWarn) add({ type: "HIGH_PAY", level: "warning", staffIds: ids,
        message: `${p.staffName}'s take-home ${inr(p.netPay)} is higher than their usual ${inr(n.net)} even without the bonus.` });
    }

    // Records
    if (n && !d?.pan && n.gross * 12 > T.panAnnualPaise) add({ type: "NO_PAN", level: "warning", staffIds: ids,
      message: `${p.staffName} earns about ${inr(n.gross * 12)} a year but has no PAN saved. It is needed for TDS.` });
    if (!d?.email && !d?.phone) add({ type: "NO_CONTACT", level: "info", staffIds: ids,
      message: `${p.staffName} has no email or phone saved, so the payslip has to be handed over by you.` });

    // Part month (expected)
    if (joined) add({ type: "JOINED", level: "info", staffIds: ids,
      message: `${p.staffName} joined on ${d!.joinedAt!.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}, so is paid for ${p.paidDays + p.lopDays} of ${p.basisDays} days. This is expected.` });
    if (left) add({ type: "LEFT", level: "info", staffIds: ids,
      message: `${p.staffName}'s last working day is in this month, so it's a part-month salary. Remember to mark them inactive after paying.` });
  }

  // Same role, very different salary (only when 3+ people share the role).
  const byRole = new Map<string, typeof payslips>();
  for (const p of payslips) {
    if (!normal.get(p.staffId)) continue;
    const d = detailOf.get(p.staffId);
    const key = (d?.designation?.trim().toLowerCase() || d?.staffType || "other");
    byRole.set(key, [...(byRole.get(key) ?? []), p]);
  }
  for (const [role, group] of byRole) {
    if (group.length < 3) continue;
    const med = median(group.map((p) => normal.get(p.staffId)!.gross));
    for (const p of group) {
      const g = normal.get(p.staffId)!.gross;
      const off = med > 0 ? (Math.abs(g - med) / med) * 100 : 0;
      if (off > T.roleWarnPct) add({ type: "ROLE_OUTLIER", level: off > T.roleCritPct ? "warning" : "info", staffIds: [p.staffId],
        message: `${p.staffName}'s monthly salary ${inr(g)} is ${Math.round(off)}% ${g > med ? "above" : "below"} others in the same role (${role}, usually around ${inr(med)}).` });
    }
  }

  // Active staff who are not in this payroll because they have no salary for the month.
  const inRun = new Set(payslips.map((p) => p.staffId));
  const monthEnd = new Date(Date.UTC(Number(run.month.slice(0, 4)), Number(run.month.slice(5, 7)), 0, 23, 59, 59));
  const missing = active.filter((s) => !inRun.has(s.id) && !structures.some((x) => x.staffId === s.id && x.effectiveFrom <= monthEnd)
    && (!s.joinedAt || s.joinedAt <= monthEnd));
  if (missing.length) add({ type: "NO_SALARY", level: "warning", staffIds: missing.map((s) => s.id),
    message: `${missing.length} active staff ${missing.length === 1 ? "has" : "have"} no salary set, so ${missing.length === 1 ? "is" : "are"} not in this payroll: ${missing.map((s) => s.name).join(", ")}.` });

  // Compare with the last published month.
  const prevRun = await academicDb().payrollRun.findFirst({
    where: { institutionId, status: "PUBLISHED", month: { lt: run.month } },
    orderBy: { month: "desc" },
    include: { payslips: { select: { staffId: true, staffName: true, netPay: true } } },
  });
  const prevNetByStaff = new Map<string, number>((prevRun?.payslips ?? []).map((p) => [p.staffId, p.netPay]));
  if (prevRun) {
    for (const p of payslips) {
      const prev = prevNetByStaff.get(p.staffId);
      if (!prev || prev <= 0) continue;
      const ch = (Math.abs(p.netPay - prev) / prev) * 100;
      if (ch >= T.changeWarnPct) add({ type: "BIG_CHANGE", level: ch >= T.changeCritPct ? "critical" : "warning", staffIds: [p.staffId],
        message: `${p.staffName}'s take-home went from ${inr(prev)} last month to ${inr(p.netPay)} (${p.netPay > prev ? "+" : "-"}${Math.round(ch)}%).` });
    }
    const gone = prevRun.payslips.filter((p) => !inRun.has(p.staffId));
    if (gone.length) add({ type: "NOT_THIS_MONTH", level: "info", staffIds: gone.map((p) => p.staffId),
      message: `Paid last month but not in this payroll: ${gone.map((p) => p.staffName).join(", ")}.` });
  }

  // Most important first.
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  warnings.sort((a, b) => rank[a.level] - rank[b.level]);

  return {
    warnings,
    prevNetByStaff,
    previous: prevRun
      ? { month: prevRun.month, staffCount: prevRun.payslips.length, netPay: prevRun.payslips.reduce((t, p) => t + p.netPay, 0) }
      : null,
  };
}

function maskPan(pan: string | null): string | null {
  if (!pan) return null;
  return pan.length >= 10 ? `${pan.slice(0, 2)}XXXXX${pan.slice(-3)}` : "XXXXX";
}

function maskBank(encrypted: string | null): { bankName: string; last4: string; ifsc: string } | null {
  const b = readStaffBankDetails(encrypted);
  if (!b || !b.accountNumber) return null;
  return { bankName: b.bankName, last4: b.accountNumber.slice(-4), ifsc: b.ifsc };
}

export const getPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");

    // A draft always shows up-to-date numbers: recalculate from the current
    // salary settings + the LOP / bonus already entered (only changed payslips
    // are written). Approved / published runs are never touched.
    if (run.status === "DRAFT") {
      try {
        const existing = await academicDb().payslip.findMany({ where: { payrollRunId: id } });
        if (existing.length) {
          await applyRunInputs(institutionId, run, existing.map((p) => ({
            payslipId: p.id, lopDays: p.lopDays, bonus: p.bonus, otherDeduction: p.otherDeduction, note: p.inputNote,
          })), { auto: true });
        }
      } catch {
        // Never block viewing the run because of a refresh problem.
      }
    }

    const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: id }, orderBy: { staffName: "asc" } });
    const staffList = await academicDb().staff.findMany({
      where: { id: { in: payslips.map((p) => p.staffId) } },
      select: { id: true, staffType: true, designation: true, employeeCode: true, paymentMode: true, phone: true, userId: true, joinedAt: true, exitDate: true, pan: true, bankDetails: true, sortOrder: true, createdAt: true },
    });
    const staffById = new Map(staffList.map((s) => [s.id, s]));
    const profiles = await loadLinkedProfiles(institutionId, staffList.map((s) => s.userId).filter((id): id is string => !!id));
    const profileOf = (staffId: string) => {
      const uid = staffById.get(staffId)?.userId;
      return uid ? profiles.get(uid) : undefined;
    };
    const review = await buildRunReview(institutionId, run, payslips, staffList);

    // Names for "Sent by X" / "Approved by Y".
    const actorIds = [run.submittedById, run.approvedById, run.publishedBy].filter((x): x is string => !!x);
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
      : [];
    const nameOf = (id: string | null) => {
      const u = id ? actors.find((a) => a.id === id) : undefined;
      return u ? u.name?.trim() || u.email : null;
    };

    res.json({
      success: true,
      data: {
        ...run,
        submittedByName: nameOf(run.submittedById),
        approvedByName: nameOf(run.approvedById),
        publishedByName: nameOf(run.publishedBy),
        warnings: review.warnings,
        previous: review.previous,
        aiReviewStale: !!run.aiReviewHash && run.aiReviewHash !== reviewHash(payslips),
        totals: {
          grossPay: payslips.reduce((s, p) => s + p.grossPay, 0),
          deductions: payslips.reduce((s, p) => s + (p.grossPay - p.netPay), 0),
          netPay: payslips.reduce((s, p) => s + p.netPay, 0),
        },
        // Same order as the Staff list (drag-and-drop order); anyone whose staff
        // row is gone goes last, by name.
        payslips: [...payslips].sort((a, b) => {
          const sa = staffById.get(a.staffId), sb = staffById.get(b.staffId);
          if (!sa || !sb) return sa ? -1 : sb ? 1 : a.staffName.localeCompare(b.staffName);
          return sa.sortOrder - sb.sortOrder || sa.createdAt.getTime() - sb.createdAt.getTime();
        }).map((p) => ({
          ...p,
          staffType: staffById.get(p.staffId)?.staffType ?? "OTHER",
          staffDesignation: staffById.get(p.staffId)?.designation || profileOf(p.staffId)?.designation || null,
          avatarUrl: profileOf(p.staffId)?.avatarUrl ?? null,
          joinedAt: staffById.get(p.staffId)?.joinedAt ?? null,
          exitDate: staffById.get(p.staffId)?.exitDate ?? null,
          // Masked only - the full account number / PAN never go to the list view.
          panMasked: maskPan(staffById.get(p.staffId)?.pan ?? null),
          bank: maskBank(staffById.get(p.staffId)?.bankDetails ?? null),
          employeeCode: staffById.get(p.staffId)?.employeeCode ?? null,
          paymentMode: staffById.get(p.staffId)?.paymentMode ?? "BANK",
          staffPhone: staffById.get(p.staffId)?.phone ?? null,
          prevNetPay: review.prevNetByStaff.get(p.staffId) ?? null,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

const paiseLineSchema = z.object({
  label: z.string().min(1).max(100),
  amount: z.number().int().min(0),
});
const editPayslipSchema = z.object({
  earnings: z.array(paiseLineSchema),
  deductions: z.array(paiseLineSchema),
});

export const updatePayslipLineItems = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const runId = req.params.id as string;
    const payslipId = req.params.payslipId as string;
    const data = editPayslipSchema.parse(req.body);

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "DRAFT") throw new BadRequestError(DRAFT_ONLY);

    const payslip = await academicDb().payslip.findFirst({ where: { id: payslipId, payrollRunId: runId, institutionId } });
    if (!payslip) throw new NotFoundError("Payslip not found");

    const grossPay = sumLineItems(data.earnings);
    const netPay = grossPay - sumLineItems(data.deductions);
    const updated = await academicDb().payslip.update({
      where: { id: payslipId },
      data: { earnings: data.earnings, deductions: data.deductions, grossPay, netPay },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

export const removePayslipFromRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const runId = req.params.id as string;
    const payslipId = req.params.payslipId as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "DRAFT") throw new BadRequestError(DRAFT_ONLY);

    const payslip = await academicDb().payslip.findFirst({ where: { id: payslipId, payrollRunId: runId, institutionId } });
    if (!payslip) throw new NotFoundError("Payslip not found");

    await academicDb().payslip.delete({ where: { id: payslipId } });
    res.json({ success: true, data: { id: payslipId } });
  } catch (err) {
    next(err);
  }
};

// Draft runs only: throw the whole run away (e.g. created for the wrong month).
export const deletePayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const runId = req.params.id as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "DRAFT") throw new BadRequestError(run.status === "PUBLISHED" ? "A published payroll run can't be deleted" : DRAFT_ONLY);

    await academicDb().$transaction(async (tx) => {
      await tx.payslip.deleteMany({ where: { payrollRunId: runId } });
      await tx.payrollRun.delete({ where: { id: runId } });
    });
    res.json({ success: true, data: { id: runId } });
  } catch (err) {
    next(err);
  }
};

const PUBLISH_STALE_MS = 5 * 60 * 1000; // no progress for 5 min = the server restarted mid-publish

// Starts publishing in the background and returns straight away (202). The
// page polls the run for publishDone / publishTotal. Each payslip is done in
// steps that are saved as they finish (PDF -> pdfUrl, email -> notifiedAt), so
// a retry continues where it stopped and never emails anyone twice.
export const publishPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { userId: adminUserId } = req.user!;
    const runId = req.params.id as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status === "PUBLISHED") throw new BadRequestError("This payroll run is already published");
    // Accountants (sub-admins) need the admin's approval first; the admin can publish directly.
    if (req.user!.role !== "ADMIN" && run.status !== "APPROVED") {
      throw new BadRequestError("This payroll needs the admin's approval before it can be published");
    }
    if (run.status === "DRAFT" && !run.inputsCheckedAt) {
      throw new BadRequestError("Tick LOP & bonus first, after checking this month's leave and bonus.");
    }

    const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: runId }, select: { id: true, pdfUrl: true, notifiedAt: true } });
    if (payslips.length === 0) throw new BadRequestError("There are no payslips in this payroll");
    const alreadyDone = payslips.filter((p) => p.pdfUrl && p.notifiedAt).length;

    // Claim the job atomically so two clicks / two people can't start it twice.
    const now = new Date();
    const claimed = await academicDb().payrollRun.updateMany({
      where: {
        id: runId,
        OR: [
          { publishState: null },
          { publishState: { not: "RUNNING" } },
          { publishHeartbeatAt: { lt: new Date(now.getTime() - PUBLISH_STALE_MS) } },
        ],
      },
      data: { publishState: "RUNNING", publishTotal: payslips.length, publishDone: alreadyDone, publishError: null, publishStartedAt: now, publishHeartbeatAt: now },
    });
    if (claimed.count === 0) throw new ConflictError("Publishing has already started for this payroll");

    const client = academicDb();
    setImmediate(() => {
      runWithAcademicClient(client, () => processPublish(institutionId, runId, adminUserId)).catch(async (err) => {
        console.error("[payroll] publish job crashed", err);
        await runWithAcademicClient(client, () => academicDb().payrollRun.update({
          where: { id: runId },
          data: { publishState: "FAILED", publishError: "Publishing stopped unexpectedly. Press Retry to continue." },
        })).catch(() => {});
      });
    });

    res.status(202).json({ success: true, data: { publishState: "RUNNING", publishTotal: payslips.length, publishDone: alreadyDone } });
  } catch (err) {
    next(err);
  }
};

async function processPublish(institutionId: string, runId: string, adminUserId: string) {
  const run = await academicDb().payrollRun.findUniqueOrThrow({ where: { id: runId } });
  const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: runId } });
  const staffList = await academicDb().staff.findMany({
    where: { id: { in: payslips.map((p) => p.staffId) } },
    select: { id: true, name: true, email: true, designation: true, userId: true, bankDetails: true, paymentMode: true },
  });
  const staffById = new Map(staffList.map((s) => [s.id, s]));
  // institution.name is central data, always safe via the plain `prisma` client.
  const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } });

  const failed: string[] = [];
  let done = payslips.filter((p) => p.pdfUrl && p.notifiedAt).length;

  for (const payslip of payslips) {
    if (payslip.pdfUrl && payslip.notifiedAt) continue;
    const staff = staffById.get(payslip.staffId);

    let ok = false;
    let lastError = "";
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        const pdfBuffer = await generatePayslipPdf({
          institutionName: institution?.name ?? "",
          staffName: payslip.staffName,
          staffDesignation: staff?.designation ?? "",
          month: run.month,
          earnings: payslip.earnings as unknown as LineItem[],
          deductions: payslip.deductions as unknown as LineItem[],
          grossPay: payslip.grossPay,
          netPay: payslip.netPay,
          paidDays: payslip.paidDays,
          basisDays: payslip.basisDays,
          lopDays: payslip.lopDays,
          bankDetails: staff?.paymentMode === "BANK" ? readStaffBankDetails(staff.bankDetails) : null,
        });

        // Step 1: PDF saved (skip if an earlier try already did it).
        if (!payslip.pdfUrl) {
          const upload = await uploadAttachmentToR2(pdfBuffer, {
            originalName: `payslip-${run.month}-${payslip.staffId}.pdf`,
            contentType: "application/pdf",
            institutionId,
            area: "payroll",
            skipSizeLimit: true,
          });
          await academicDb().payslip.update({ where: { id: payslip.id }, data: { pdfUrl: upload.publicUrl } });
          payslip.pdfUrl = upload.publicUrl;
        }

        // Step 2: tell the person (once).
        if (!payslip.notifiedAt) {
          if (staff?.userId) {
            await createNotification({
              title: "Your payslip is ready",
              message: `Your payslip for ${run.month} has been published.`,
              tag: "PAYSLIP_PUBLISHED",
              recipientType: "USER",
              sentById: adminUserId,
              recipients: [{ institutionId, userId: staff.userId }],
            });
          }
          // Payroll-only staff may have no email - they get the PDF by download / WhatsApp.
          const email = staff?.email ?? payslip.staffEmail;
          if (email) {
            await sendPayslipEmail({ to: email, staffName: payslip.staffName, institutionName: institution?.name ?? "", month: run.month, pdfBuffer });
          }
          const notifiedAt = new Date();
          await academicDb().payslip.update({ where: { id: payslip.id }, data: { notifiedAt } });
          payslip.notifiedAt = notifiedAt;
        }
        ok = true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (ok) done += 1;
    else failed.push(`${payslip.staffName} (${lastError.slice(0, 120)})`);
    await academicDb().payrollRun.update({ where: { id: runId }, data: { publishDone: done, publishHeartbeatAt: new Date() } });
  }

  if (failed.length) {
    await academicDb().payrollRun.update({
      where: { id: runId },
      data: { publishState: "FAILED", publishError: `${failed.length} payslip${failed.length === 1 ? "" : "s"} could not be sent: ${failed.join("; ")}. Press Retry to try them again.`.slice(0, 1000) },
    });
    return;
  }

  await academicDb().payrollRun.update({
    where: { id: runId },
    data: { status: "PUBLISHED", publishedAt: new Date(), publishedBy: adminUserId, publishState: null, publishError: null },
  });
}

const markPaidSchema = z.object({
  paymentMethod: z.string().max(100).optional(),
  paymentRef: z.string().max(100).optional(),
});

export const markPayslipPaid = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;
    const data = markPaidSchema.parse(req.body);

    const payslip = await academicDb().payslip.findFirst({ where: { id, institutionId } });
    if (!payslip) throw new NotFoundError("Payslip not found");

    const updated = await academicDb().payslip.update({
      where: { id },
      data: { status: "PAID", paidAt: new Date(), paymentMethod: data.paymentMethod, paymentRef: data.paymentRef },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// Bulk "Mark all paid" for a published run: every unpaid payslip becomes PAID,
// with the payment method taken from each person's payment mode.
const PAYMENT_MODE_NAME: Record<string, string> = { BANK: "Bank transfer", CASH: "Cash", CHEQUE: "Cheque" };

export const markAllPayslipsPaid = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const runId = req.params.id as string;

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "PUBLISHED") throw new BadRequestError("Publish the payslips before marking them paid");

    const pending = await academicDb().payslip.findMany({
      where: { payrollRunId: runId, institutionId, status: { not: "PAID" } },
      select: { id: true, staffId: true },
    });
    if (pending.length === 0) return res.json({ success: true, data: { count: 0 } });

    const staff = await academicDb().staff.findMany({
      where: { id: { in: pending.map((p) => p.staffId) } },
      select: { id: true, paymentMode: true },
    });
    const modeOf = new Map(staff.map((s) => [s.id, s.paymentMode]));
    const paidAt = new Date();

    await academicDb().$transaction(
      pending.map((p) =>
        academicDb().payslip.update({
          where: { id: p.id },
          data: { status: "PAID", paidAt, paymentMethod: PAYMENT_MODE_NAME[modeOf.get(p.staffId) ?? "BANK"] ?? "Bank transfer" },
        }),
      ),
    );
    res.json({ success: true, data: { count: pending.length } });
  } catch (err) {
    next(err);
  }
};

// Undo a "Mark paid" done by mistake: back to unpaid, payment info cleared.
export const markPayslipUnpaid = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const id = req.params.id as string;

    const payslip = await academicDb().payslip.findFirst({ where: { id, institutionId } });
    if (!payslip) throw new NotFoundError("Payslip not found");
    if (payslip.status !== "PAID") throw new BadRequestError("This payslip isn't marked as paid");

    const updated = await academicDb().payslip.update({
      where: { id },
      data: { status: "PENDING", paidAt: null, paymentMethod: null, paymentRef: null },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// ── Monthly inputs (LOP / bonus grid) and the approval flow ───────────────────

const runInputsSchema = z.object({
  items: z.array(z.object({
    payslipId: z.string(),
    lopDays: z.number().min(0).max(31).refine((n) => Number.isInteger(n * 2), "LOP days must be whole or half days"),
    bonus: z.number().int().min(0).max(100_000_000), // paise
    otherDeduction: z.number().int().min(0).max(100_000_000), // paise
    note: z.string().trim().max(200).optional().nullable(),
  })).min(1).max(2000),
});

// Save the grid and recalculate each changed payslip from the staff's salary
// structure for that month (same engine as run creation).
type RunInputItem = z.infer<typeof runInputsSchema>["items"][number];

// Recalculate payslips of a draft run from each person's salary for the month
// plus the given LOP / bonus inputs (same engine as run creation).
async function applyRunInputs(institutionId: string, run: { id: string; month: string }, items: RunInputItem[], opts: { auto?: boolean } = {}): Promise<number> {
  const runId = run.id;
    const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: runId, id: { in: items.map((i) => i.payslipId) } } });
    if (payslips.length !== new Set(items.map((i) => i.payslipId)).size) throw new BadRequestError("Some payslips were not found in this run");

    const [components, settings, staffList, structures] = await Promise.all([
      loadComponents(institutionId),
      loadPayrollSettings(institutionId),
      academicDb().staff.findMany({ where: { id: { in: payslips.map((p) => p.staffId) } }, select: { id: true, joinedAt: true, exitDate: true } }),
      academicDb().staffSalaryStructure.findMany({ where: { institutionId, staffId: { in: payslips.map((p) => p.staffId) } } }),
    ]);
    const staffById = new Map(staffList.map((s) => [s.id, s]));

    const updates: ReturnType<ReturnType<typeof academicDb>["payslip"]["update"]>[] = [];
    for (const item of items) {
      const payslip = payslips.find((p) => p.id === item.payslipId)!;
      const structure = structureForMonth(structures.filter((x) => x.staffId === payslip.staffId), run.month);
      if (!structure) {
        if (opts.auto) continue; // auto refresh: leave it as it is
        throw new BadRequestError(`${payslip.staffName} has no salary for ${run.month}`);
      }
      const staff = staffById.get(payslip.staffId);
      const note = item.note?.trim() || null;
      const adjustments = [
        ...(item.bonus ? [{ label: note && item.bonus ? `Bonus (${note})` : "Bonus", type: "EARNING" as const, amount: item.bonus }] : []),
        ...(item.otherDeduction ? [{ label: note && !item.bonus ? `Other deduction (${note})` : "Other deduction", type: "DEDUCTION" as const, amount: item.otherDeduction }] : []),
      ];
      const result = calculateSalary({
        month: run.month,
        items: structure.items as unknown as StructureItem[],
        components,
        dayBasis: settings.dayBasis,
        lopDays: item.lopDays,
        joinedAt: staff?.joinedAt ?? null,
        exitDate: staff?.exitDate ?? null,
        adjustments,
      });
      if (item.lopDays > result.basisDays) {
        if (opts.auto) continue;
        throw new BadRequestError(`${payslip.staffName}: LOP days can't be more than ${result.basisDays}`);
      }
      // Auto refresh only writes payslips whose numbers actually changed.
      if (opts.auto
        && payslip.grossPay === result.grossPay && payslip.netPay === result.netPay && payslip.paidDays === result.paidDays
        && JSON.stringify(payslip.earnings) === JSON.stringify(result.earnings)
        && JSON.stringify(payslip.deductions) === JSON.stringify(result.deductions)) continue;
      updates.push(academicDb().payslip.update({
        where: { id: payslip.id },
        data: {
          earnings: toJson(result.earnings), deductions: toJson(result.deductions),
          grossPay: result.grossPay, netPay: result.netPay,
          lopDays: result.lopDays, paidDays: result.paidDays, basisDays: result.basisDays,
          bonus: item.bonus, otherDeduction: item.otherDeduction, inputNote: note,
        },
      }));
    }
    if (updates.length) await academicDb().$transaction(updates);
  return updates.length;
}

export const saveRunInputs = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const runId = req.params.id as string;
    const { items } = runInputsSchema.parse(req.body);

    const run = await academicDb().payrollRun.findFirst({ where: { id: runId, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "DRAFT") throw new BadRequestError(DRAFT_ONLY);

    const count = await applyRunInputs(institutionId, run, items);
    res.json({ success: true, data: { count } });
  } catch (err) {
    next(err);
  }
};

// The tick next to the "LOP & bonus" button: { checked: true } = LOP & bonus
// for this month has been looked at; false = untick.
const inputsCheckedSchema = z.object({ checked: z.boolean() });

export const markRunInputsChecked = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { checked } = inputsCheckedSchema.parse(req.body);
    const run = await academicDb().payrollRun.findFirst({ where: { id: req.params.id as string, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "DRAFT") throw new BadRequestError(DRAFT_ONLY);
    const updated = await academicDb().payrollRun.update({
      where: { id: run.id },
      data: checked ? { inputsCheckedAt: new Date(), inputsCheckedById: req.user!.userId } : { inputsCheckedAt: null, inputsCheckedById: null },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

const CHECK_INPUTS_FIRST = "Tick LOP & bonus first, after checking this month's leave and bonus.";

async function notifyUsers(institutionId: string, userIds: (string | null | undefined)[], title: string, message: string, sentById: string) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== sentById))];
  if (!ids.length) return;
  try {
    await createNotification({
      title, message, tag: "PAYROLL", recipientType: "USER", sentById,
      recipients: ids.map((userId) => ({ institutionId, userId })),
    });
  } catch {
    // A failed notification must never block the payroll action itself.
  }
}

async function adminUserIds(institutionId: string): Promise<string[]> {
  const admins = await prisma.user.findMany({ where: { institutionId, role: "ADMIN" }, select: { id: true } });
  return admins.map((a) => a.id);
}

const monthName = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
};

async function loadRunForAction(req: AuthRequest) {
  const institutionId = requireInstitution(req);
  const run = await academicDb().payrollRun.findFirst({ where: { id: req.params.id as string, institutionId } });
  if (!run) throw new NotFoundError("Payroll run not found");
  return { institutionId, run };
}

// Accountant: DRAFT -> PENDING_APPROVAL
export const submitPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, run } = await loadRunForAction(req);
    if (run.status !== "DRAFT") throw new BadRequestError("Only a draft payroll can be sent for approval");
    if (!run.inputsCheckedAt) throw new BadRequestError(CHECK_INPUTS_FIRST);
    const count = await academicDb().payslip.count({ where: { payrollRunId: run.id } });
    if (count === 0) throw new BadRequestError("There are no payslips in this payroll");

    const updated = await academicDb().payrollRun.update({
      where: { id: run.id },
      data: { status: "PENDING_APPROVAL", submittedAt: new Date(), submittedById: req.user!.userId, approvedAt: null, approvedById: null },
    });
    await notifyUsers(institutionId, await adminUserIds(institutionId), "Payroll waiting for your approval",
      `${monthName(run.month)} payroll (${count} staff) has been sent for approval.`, req.user!.userId);
    // Write the AI observation once now (numbers are locked from here), in the
    // background so sending isn't slowed down. Failures just mean the page asks later.
    const client = academicDb();
    const actor = { userId: req.user!.userId, role: req.user!.role };
    setImmediate(() => {
      runWithAcademicClient(client, () => writeObservation(institutionId, run, actor)).catch((err) =>
        console.error("[payroll-ai] observation on submit failed:", err instanceof Error ? err.message : err));
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// Accountant: pull a pending run back to draft (before the admin acts).
export const recallPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { run } = await loadRunForAction(req);
    if (run.status !== "PENDING_APPROVAL") throw new BadRequestError("Only a payroll waiting for approval can be taken back");
    const updated = await academicDb().payrollRun.update({ where: { id: run.id }, data: { status: "DRAFT" } });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// Admin: PENDING_APPROVAL -> APPROVED
export const approvePayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, run } = await loadRunForAction(req);
    if (run.status !== "PENDING_APPROVAL") throw new BadRequestError("This payroll isn't waiting for approval");
    const updated = await academicDb().payrollRun.update({
      where: { id: run.id },
      data: { status: "APPROVED", approvedAt: new Date(), approvedById: req.user!.userId, reviewNote: null, reviewNoteAt: null },
    });
    await notifyUsers(institutionId, [run.submittedById], "Payroll approved",
      `${monthName(run.month)} payroll is approved. You can publish the payslips now.`, req.user!.userId);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

const sendBackSchema = z.object({ note: z.string().trim().min(1, "Add a note so the accountant knows what to fix").max(500) });

// Admin: PENDING_APPROVAL / APPROVED -> DRAFT, with a note for the accountant.
export const sendBackPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, run } = await loadRunForAction(req);
    const { note } = sendBackSchema.parse(req.body);
    if (run.status !== "PENDING_APPROVAL" && run.status !== "APPROVED") throw new BadRequestError("Only a payroll waiting for approval or approved can be sent back");
    if (run.publishState === "RUNNING") throw new BadRequestError("Payslips are being published right now");
    const updated = await academicDb().payrollRun.update({
      where: { id: run.id },
      data: { status: "DRAFT", reviewNote: note, reviewNoteAt: new Date(), approvedAt: null, approvedById: null, inputsCheckedAt: null, inputsCheckedById: null },
    });
    await notifyUsers(institutionId, [run.submittedById], "Payroll sent back",
      `${monthName(run.month)} payroll needs changes: ${note}`, req.user!.userId);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// ── Paying salaries: bank file, UTR entry ─────────────────────────────────────

// Spreadsheet apps run cells starting with = + - @ as formulas; prefix them.
const csvCell = (v: string | number | null | undefined): string => {
  let t = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const rupees = (paise: number) => (paise / 100).toFixed(2);

// CSV the school uploads to its bank's bulk-payment page (or pays from by hand).
// ?list=bank (default): bank-transfer staff with account details.
// ?list=other: cash / cheque staff.
// Only unpaid payslips, once the payroll is approved or published.
export const exportRunPayments = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const run = await academicDb().payrollRun.findFirst({ where: { id: req.params.id as string, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "APPROVED" && run.status !== "PUBLISHED") throw new BadRequestError("The payment file is available once the payroll is approved");
    const list = req.query.list === "other" ? "other" : "bank";

    const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: run.id, status: { not: "PAID" } } });
    const staff = await academicDb().staff.findMany({
      where: { id: { in: payslips.map((p) => p.staffId) } },
      select: { id: true, employeeCode: true, paymentMode: true, bankDetails: true, sortOrder: true, createdAt: true },
    });
    const staffById = new Map(staff.map((s) => [s.id, s]));
    const ordered = [...payslips].sort((a, b) => {
      const sa = staffById.get(a.staffId), sb = staffById.get(b.staffId);
      return (sa?.sortOrder ?? 0) - (sb?.sortOrder ?? 0) || (sa?.createdAt.getTime() ?? 0) - (sb?.createdAt.getTime() ?? 0);
    });
    const narration = `Salary ${monthName(run.month)}`;

    let rows: string[][];
    if (list === "bank") {
      rows = [["Sr No", "Employee Code", "Beneficiary Name", "Account Number", "IFSC", "Bank Name", "Amount", "Narration"]];
      let i = 0;
      for (const p of ordered) {
        const s = staffById.get(p.staffId);
        if ((s?.paymentMode ?? "BANK") !== "BANK") continue;
        const bank = readStaffBankDetails(s?.bankDetails ?? null);
        if (!bank?.accountNumber) continue; // flagged in the UI as "bank details missing"
        rows.push([String(++i), s?.employeeCode ?? "", bank.accountName || p.staffName, bank.accountNumber, bank.ifsc, bank.bankName, rupees(p.netPay), narration]);
      }
    } else {
      rows = [["Sr No", "Employee Code", "Name", "Pay by", "Amount"]];
      let i = 0;
      for (const p of ordered) {
        const s = staffById.get(p.staffId);
        if ((s?.paymentMode ?? "BANK") === "BANK") continue;
        rows.push([String(++i), s?.employeeCode ?? "", p.staffName, s?.paymentMode === "CHEQUE" ? "Cheque" : "Cash", rupees(p.netPay)]);
      }
    }

    const csv = "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"; // BOM so Excel reads ₹ names right
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="salary-${list === "bank" ? "bank" : "cash-cheque"}-${run.month}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

const bulkPaidSchema = z.object({
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  items: z.array(z.object({
    payslipId: z.string(),
    paymentRef: z.string().trim().max(100).optional().nullable(), // UTR / cheque no.
  })).min(1).max(2000),
});

// Mark several payslips paid at once, each with its own UTR / reference.
export const markPayslipsPaidBulk = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const { items, paidOn } = bulkPaidSchema.parse(req.body);
    const run = await academicDb().payrollRun.findFirst({ where: { id: req.params.id as string, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status !== "PUBLISHED") throw new BadRequestError("Publish the payslips before marking them paid");

    const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: run.id, id: { in: items.map((i) => i.payslipId) } }, select: { id: true, staffId: true } });
    if (payslips.length !== new Set(items.map((i) => i.payslipId)).size) throw new BadRequestError("Some payslips were not found in this run");
    const staff = await academicDb().staff.findMany({ where: { id: { in: payslips.map((p) => p.staffId) } }, select: { id: true, paymentMode: true } });
    const modeOf = new Map(staff.map((s) => [s.id, s.paymentMode]));
    const paidAt = paidOn ? new Date(`${paidOn}T00:00:00.000Z`) : new Date();

    await academicDb().$transaction(items.map((item) => {
      const p = payslips.find((x) => x.id === item.payslipId)!;
      return academicDb().payslip.update({
        where: { id: item.payslipId },
        data: {
          status: "PAID", paidAt,
          paymentMethod: PAYMENT_MODE_NAME[modeOf.get(p.staffId) ?? "BANK"] ?? "Bank transfer",
          paymentRef: item.paymentRef?.trim() || null,
        },
      });
    }));
    res.json({ success: true, data: { count: items.length } });
  } catch (err) {
    next(err);
  }
};

// ── AI review ─────────────────────────────────────────────────────────────────

// Smart Review's AI summary: the rule-based findings are turned into a short
// summary by the AI. Saved on the run (shown again without another AI call)
// with a fingerprint of the numbers, so the page can say when it's out of date.
// Write the AI observation for a run and save it (with a fingerprint of the numbers).
async function writeObservation(institutionId: string, run: { id: string; month: string }, user: { userId: string; role: string }) {
  const payslips = await academicDb().payslip.findMany({ where: { payrollRunId: run.id } });
  const staffList = await academicDb().staff.findMany({
    where: { id: { in: payslips.map((p) => p.staffId) } },
    select: { id: true, paymentMode: true, bankDetails: true },
  });
  const review = await buildRunReview(institutionId, run, payslips, staffList);
  const result = await generatePayrollAiSummary({
    month: run.month,
    staffCount: payslips.length,
    totalNet: payslips.reduce((t, p) => t + p.netPay, 0),
    previous: review.previous,
    findings: review.warnings.map((w) => ({ level: w.level, message: w.message })),
    // Every staff name of the school, so names in any finding get hidden from the AI.
    staffNames: [...payslips.map((p) => p.staffName), ...(await academicDb().staff.findMany({ where: { institutionId }, select: { name: true } })).map((x) => x.name)],
  }, { institutionId, userId: user.userId, userRole: user.role });
  return academicDb().payrollRun.update({
    where: { id: run.id },
    data: { aiReview: toJson(result), aiReviewAt: new Date(), aiReviewHash: reviewHash(payslips) },
    select: { aiReview: true, aiReviewAt: true },
  });
}

// AI observation on demand (the page asks for it when a run waiting for
// approval / approved has none yet). Drafts don't get one: numbers keep
// changing there, so writing it on every LOP / bonus edit would waste tokens.
export const aiReviewPayrollRun = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const run = await academicDb().payrollRun.findFirst({ where: { id: req.params.id as string, institutionId } });
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status === "DRAFT") throw new BadRequestError("The observation is written when the payroll is sent for approval");
    // Already written for these exact numbers (e.g. by the background job on submit): no new AI call.
    if (run.aiReview && run.aiReviewHash) {
      const current = await academicDb().payslip.findMany({ where: { payrollRunId: run.id } });
      if (reviewHash(current) === run.aiReviewHash) {
        return res.json({ success: true, data: { aiReview: run.aiReview, aiReviewAt: run.aiReviewAt, aiReviewStale: false } });
      }
    }
    const saved = await writeObservation(institutionId, run, { userId: req.user!.userId, role: req.user!.role });
    res.json({ success: true, data: { ...saved, aiReviewStale: false } });
  } catch (err) {
    next(err);
  }
};
