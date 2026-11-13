import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { BorrowerType, borrowerTypeForRole, normaliseCode } from "./library.rules";

const BORROWER_ROLES = ["STUDENT", "TEACHER", "ADMIN", "SUB_ADMIN"] as const;

export type Member = {
  userId: string;
  name: string;
  code: string;
  borrowerType: BorrowerType;
  isActive: boolean;
  activeLoans: number;
};

const userSelect = { id: true, name: true, role: true, isActive: true, displayId: true } as const;

// A member is found by display ID first (everyone has one), then by student ID, then by teacher ID.
export async function resolveMember(institutionId: string, rawCode: string): Promise<Member | null> {
  const code = normaliseCode(rawCode);
  if (!code) return null;
  const roleFilter = { in: [...BORROWER_ROLES] };

  let user = await prisma.user.findFirst({
    where: { institutionId, role: roleFilter, displayId: { equals: code, mode: "insensitive" } },
    select: userSelect,
  });
  if (!user) {
    const student = await academicDb().student.findFirst({
      where: { institutionId, studentId: { equals: code, mode: "insensitive" } }, select: { userId: true },
    });
    const teacher = student ? null : await academicDb().teacher.findFirst({
      where: { institutionId, teacherId: { equals: code, mode: "insensitive" } }, select: { userId: true },
    });
    const userId = student?.userId ?? teacher?.userId;
    if (userId) user = await prisma.user.findFirst({ where: { id: userId, institutionId, role: roleFilter }, select: userSelect });
  }
  if (!user) return null;

  const activeLoans = await academicDb().libraryLoan.count({
    where: { institutionId, borrowerUserId: user.id, returnedAt: null },
  });
  return {
    userId: user.id,
    name: user.name ?? "Unnamed",
    code: user.displayId ?? code,
    borrowerType: borrowerTypeForRole(user.role),
    isActive: user.isActive,
    activeLoans,
  };
}
