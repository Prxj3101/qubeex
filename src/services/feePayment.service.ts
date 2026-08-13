import { academicDb } from "../utils/academicContext";

export interface FeePaymentEntry {
  studentId: string;
  feeMonthId: string;
  status: "PAID" | "PENDING";
  paidDate: string | null;
  remark: string | null;
  extraFields: Record<string, string> | null;
  extraStructureIds: string[] | null;
}

export async function getDivisionFeePaymentsData(
  divisionId: string,
  institutionId: string
): Promise<FeePaymentEntry[]> {
  const payments = await academicDb().studentFeePayment.findMany({
    where: { institutionId, student: { divisionId, institutionId } },
    select: { studentId: true, feeMonthId: true, status: true, paidDate: true, remark: true, extraFields: true, extraStructureIds: true },
  });

  return payments.map((p) => ({
    studentId: p.studentId,
    feeMonthId: p.feeMonthId,
    status: p.status === "PAID" ? "PAID" : "PENDING",
    paidDate: p.paidDate,
    remark: p.remark,
    extraFields: (p.extraFields as Record<string, string> | null) ?? null,
    extraStructureIds: (p.extraStructureIds as string[] | null) ?? null,
  }));
}

export async function upsertFeePaymentData(params: {
  institutionId: string;
  studentId: string;
  feeMonthId: string;
  status: "PAID" | "PENDING";
  paidDate: string | null;
  remark: string | null;
  extraFields: Record<string, string> | null;
  extraStructureIds: string[] | null;
}): Promise<FeePaymentEntry> {
  const { institutionId, studentId, feeMonthId, status, paidDate, remark, extraFields, extraStructureIds } = params;

  const payment = await academicDb().studentFeePayment.upsert({
    where: { studentId_feeMonthId: { studentId, feeMonthId } },
    create: { institutionId, studentId, feeMonthId, status, paidDate, remark, extraFields: extraFields ?? undefined, extraStructureIds: extraStructureIds ?? undefined },
    update: { status, paidDate, remark, extraFields: extraFields ?? undefined, extraStructureIds: extraStructureIds ?? undefined },
    select: { studentId: true, feeMonthId: true, status: true, paidDate: true, remark: true, extraFields: true, extraStructureIds: true },
  });

  return {
    studentId: payment.studentId,
    feeMonthId: payment.feeMonthId,
    status: payment.status === "PAID" ? "PAID" : "PENDING",
    paidDate: payment.paidDate,
    remark: payment.remark,
    extraFields: (payment.extraFields as Record<string, string> | null) ?? null,
    extraStructureIds: (payment.extraStructureIds as string[] | null) ?? null,
  };
}
