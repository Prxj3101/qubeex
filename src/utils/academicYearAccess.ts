// src/utils/academicYearAccess.ts
import { academicDb } from "./academicContext";

export interface AcademicYearAccessParams {
  role: string;
  userId: string;
  institutionId: string;
  academicYearId: string;
  divisionId?: string;
  studentId?: string;
}

/**
 * Shared authorization gate for every year-aware route. Throws `{ status, message }`
 * on any violation; resolves silently when access is allowed.
 *
 * Deny-by-default: any role that isn't explicitly recognized, or any ambiguous/missing
 * input, results in a rejection rather than access being granted.
 */
export async function assertAcademicYearAccess(params: AcademicYearAccessParams): Promise<void> {
  const { role, userId, institutionId, academicYearId, divisionId, studentId } = params;
  const db = academicDb();

  if (!institutionId || !academicYearId || !userId) {
    throw { status: 403, message: "Missing required access parameters" };
  }

  const year = await db.academicYear.findFirst({ where: { id: academicYearId, institutionId } });
  if (!year) throw { status: 404, message: "Academic year not found" };

  // SUB_ADMIN gets the same year-level access as ADMIN: this function only gates
  // *which year* may be read, not *which data*. Route-level requirePermission
  // middleware already restricts which endpoints/data a sub-admin can reach.
  if (role === "ADMIN" || role === "SUPER_ADMIN" || role === "SUB_ADMIN") return;

  if (role === "TEACHER") {
    const teacher = await db.teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
    if (!teacher) throw { status: 404, message: "Teacher profile not found" };
    if (!divisionId) return; // no division-specific check requested
    const assignment = await db.divisionAssignment.findFirst({
      where: { divisionId, teacherId: teacher.id, institutionId, academicYearId },
      select: { id: true },
    });
    if (!assignment) throw { status: 403, message: "Not assigned to this division in the selected academic year" };
    return;
  }

  if (role === "STUDENT") {
    const student = await db.student.findFirst({ where: { userId, institutionId }, select: { id: true } });
    if (!student) throw { status: 404, message: "Student profile not found" };
    if (studentId && studentId !== student.id) {
      throw { status: 403, message: "Cannot access another student's data" };
    }
    const enrollment = await db.studentEnrollment.findFirst({
      where: { studentId: student.id, academicYearId, institutionId },
      select: { id: true },
    });
    if (!enrollment) throw { status: 403, message: "No enrollment found for this academic year" };
    return;
  }

  // Deny by default for any role not explicitly handled above (e.g.
  // unexpected/empty strings, or any future role added to the enum without a
  // corresponding rule here).
  throw { status: 403, message: "Unsupported role for academic year access" };
}
