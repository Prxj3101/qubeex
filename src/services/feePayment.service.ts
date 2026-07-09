import { prisma } from "../utils/prisma";

export interface FeePaymentEntry {
  studentId: string;
  feeMonthId: string;
  status: "PAID" | "PENDING";
  paidDate: string | null;
}

export async function getDivisionFeePaymentsData(
  divisionId: string,
  institutionId: string
): Promise<FeePaymentEntry[]> {
  const payments = await prisma.studentFeePayment.findMany({
    where: { institutionId, student: { divisionId, institutionId } },
    select: { studentId: true, feeMonthId: true, status: true, paidDate: true },
  });

  return payments.map((p) => ({
    studentId: p.studentId,
    feeMonthId: p.feeMonthId,
    status: p.status === "PAID" ? "PAID" : "PENDING",
    paidDate: p.paidDate,
  }));
}

export async function upsertFeePaymentData(params: {
  institutionId: string;
  studentId: string;
  feeMonthId: string;
  status: "PAID" | "PENDING";
  paidDate: string | null;
}): Promise<FeePaymentEntry> {
  const { institutionId, studentId, feeMonthId, status, paidDate } = params;

  const payment = await prisma.studentFeePayment.upsert({
    where: { studentId_feeMonthId: { studentId, feeMonthId } },
    create: { institutionId, studentId, feeMonthId, status, paidDate },
    update: { status, paidDate },
    select: { studentId: true, feeMonthId: true, status: true, paidDate: true },
  });

  return {
    studentId: payment.studentId,
    feeMonthId: payment.feeMonthId,
    status: payment.status === "PAID" ? "PAID" : "PENDING",
    paidDate: payment.paidDate,
  };
}
