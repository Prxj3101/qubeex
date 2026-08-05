import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { z } from "zod";
import { logAudit } from "../../services/audit.service";
import { createRemarkSchema, reviewRemarkSchema, editRemarkSchema } from "../../services/remark.schema";
import { createStudentRemark, listStudentRemarks, listAssignedRemarks, reviewStudentRemark, deleteStudentRemark, editStudentRemark } from "../../services/remark.service";
import { getDivisionLeaderboardData } from "../../services/leaderboard.service";
import { getStudentStatsData } from "../../services/studentStats.service";
import { getStudentMarksheetData } from "../../services/studentMarksheet.service";
import { getStudentAttendanceTrendData } from "../../services/studentAttendanceTrend.service";
import { getStudentAttendanceDetailData } from "../../services/studentAttendanceDetail.service";
import { getDivisionFeePaymentsData, upsertFeePaymentData } from "../../services/feePayment.service";
import { upsertFeePaymentSchema } from "../../services/feePayment.schema";

function requireInstitution(req: AuthRequest) {
  const { institutionId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution");
  return institutionId;
}

async function findStudentInDivision(studentId: string, divisionId: string, institutionId: string) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, divisionId, institutionId },
    select: { id: true },
  });
  if (!student) throw new NotFoundError("Student not found in this division");
}

// GET /admin/campus/divisions/:divisionId/students/:studentId/stats
export const getStudentStats = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;

    await findStudentInDivision(studentId, divisionId, institutionId);

    const data = await getStudentStatsData(studentId, divisionId, institutionId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

// PATCH /admin/campus/divisions/:divisionId/students/:studentId
export const updateStudentStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;
    const { status } = updateStatusSchema.parse(req.body);

    const student = await prisma.student.findFirst({
      where: { id: studentId, divisionId, institutionId },
      select: { id: true, userId: true, user: { select: { name: true } } },
    });
    if (!student) throw new NotFoundError("Student not found in this division");

    const [updated] = await prisma.$transaction([
      prisma.student.update({ where: { id: studentId }, data: { status } }),
      prisma.user.update({ where: { id: student.userId }, data: { isActive: status === "ACTIVE" } }),
    ]);

    logAudit(status === "INACTIVE" ? "STUDENT_DEACTIVATED" : "STUDENT_ACTIVATED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Student ${student.user?.name ?? ""} ${status === "INACTIVE" ? "deactivated" : "activated"}`,
      metadata: { studentId },
      category: "ADMIN_ACTION",
      severity: status === "INACTIVE" ? "WARNING" : "INFO",
    });

    res.json({ success: true, data: { id: updated.id, status: updated.status } });
  } catch (err) {
    next(err);
  }
};

// POST /admin/campus/divisions/:divisionId/students/:studentId/remarks
export const reportStudent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;

    await findStudentInDivision(studentId, divisionId, institutionId);

    const data = createRemarkSchema.parse(req.body);
    const remark = await createStudentRemark({
      institutionId,
      studentId,
      divisionId,
      reportedByUserId: req.user!.userId,
      reportedByRole: "Admin",
      viewer: { userId: req.user!.userId, role: req.user!.role },
      data,
    });

    logAudit("STUDENT_REPORTED", {
      userId: req.user!.userId,
      actorRole: "ADMIN",
      institutionId,
      details: `${data.severity} severity report filed for student: ${data.title}`,
    });

    res.status(201).json({ success: true, data: remark });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/students/:studentId/remarks
export const getStudentRemarks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;

    await findStudentInDivision(studentId, divisionId, institutionId);

    const remarks = await listStudentRemarks(studentId, institutionId, { userId: req.user!.userId, role: req.user!.role });
    res.json({ success: true, data: remarks });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/reports/inbox — all institution reports (admin sees everything)
export const getReportsInbox = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const reports = await listAssignedRemarks(institutionId, { userId: req.user!.userId, role: req.user!.role });
    res.json({ success: true, data: reports });
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/campus/reports/:remarkId — review/action a report
export const reviewReport = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const remarkId = req.params.remarkId as string;
    const data = reviewRemarkSchema.parse(req.body);
    const updated = await reviewStudentRemark({
      remarkId,
      institutionId,
      viewer: { userId: req.user!.userId, role: req.user!.role },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      res.status(e.status).json({ success: false, error: e.message });
      return;
    }
    next(err);
  }
};

// PATCH /admin/campus/reports/:remarkId/edit — reporter edits their own card's content
export const editReport = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const remarkId = req.params.remarkId as string;
    const data = editRemarkSchema.parse(req.body);
    const updated = await editStudentRemark({
      remarkId,
      institutionId,
      viewer: { userId: req.user!.userId, role: req.user!.role },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      res.status(e.status).json({ success: false, error: e.message });
      return;
    }
    next(err);
  }
};

// DELETE /admin/campus/reports/:remarkId — admin deletes a card entirely.
// It disappears from the admin inbox, the teacher's assigned reports, and the
// student's own Flags & Warnings board in one shot, since they all read the
// same StudentRemark row.
export const deleteReport = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const remarkId = req.params.remarkId as string;

    await deleteStudentRemark({ remarkId, institutionId });

    logAudit("STUDENT_REPORT_DELETED", {
      userId: req.user!.userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Deleted student report card ${remarkId}`,
    });

    res.json({ success: true, data: { id: remarkId } });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      res.status(e.status).json({ success: false, error: e.message });
      return;
    }
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/students/:studentId/marksheet
export const getStudentMarksheet = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;

    await findStudentInDivision(studentId, divisionId, institutionId);

    const data = await getStudentMarksheetData(divisionId, studentId, institutionId);
    if (!data) {
      res.status(404).json({ success: false, error: "Results not published yet" });
      return;
    }
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/students/:studentId/attendance-trend
export const getStudentAttendanceTrend = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;

    await findStudentInDivision(studentId, divisionId, institutionId);

    const data = await getStudentAttendanceTrendData(studentId, institutionId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/students/:studentId/attendance
export const getStudentAttendanceDetail = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;

    await findStudentInDivision(studentId, divisionId, institutionId);

    const data = await getStudentAttendanceDetailData(studentId, institutionId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/leaderboard
export const getDivisionLeaderboard = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;

    const data = await getDivisionLeaderboardData(divisionId, institutionId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /admin/campus/divisions/:divisionId/fee-payments
export const getDivisionFeePayments = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;

    const data = await getDivisionFeePaymentsData(divisionId, institutionId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const updateDetailFieldSchema = z.object({
  fieldId: z.string().min(1),
  value: z.string().max(500),
});

// PATCH /admin/campus/divisions/:divisionId/students/:studentId/detail-fields
export const updateStudentDetailField = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const studentId = req.params.studentId as string;
    const { fieldId, value } = updateDetailFieldSchema.parse(req.body);

    const student = await prisma.student.findFirst({
      where: { id: studentId, divisionId, institutionId },
      select: { id: true, extraDetailFields: true },
    });
    if (!student) throw new NotFoundError("Student not found in this division");

    const nextFields = { ...((student.extraDetailFields as Record<string, string> | null) ?? {}), [fieldId]: value };

    const updated = await prisma.student.update({
      where: { id: studentId },
      data: { extraDetailFields: nextFields },
      select: { extraDetailFields: true },
    });

    res.json({ success: true, data: { extraDetailFields: updated.extraDetailFields } });
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/campus/divisions/:divisionId/fee-payments
export const updateFeePayment = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = requireInstitution(req);
    const divisionId = req.params.divisionId as string;
    const body = upsertFeePaymentSchema.parse(req.body);

    await findStudentInDivision(body.studentId, divisionId, institutionId);

    const data = await upsertFeePaymentData({
      institutionId,
      studentId: body.studentId,
      feeMonthId: body.feeMonthId,
      status: body.status,
      paidDate: body.paidDate ?? null,
      remark: body.remark ?? null,
      extraFields: body.extraFields ?? null,
      extraStructureIds: body.extraStructureIds ?? null,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
