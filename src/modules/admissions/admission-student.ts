import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { generateUserId } from "../../utils/userId";
import { upsertCurrentEnrollment } from "../../utils/academicYear";
import { recordUserStatusEvent } from "../../services/userStatusEvent.service";
import { buildStudentPIIUpdate } from "../../services/fieldEncryption.service";
import { busNeed, type Details } from "./admissions.shared";
import { BUS_REQUEST_KEY } from "../../services/studentBus.service";

const BCRYPT_ROUNDS = 12;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!";
const tempPassword = () => Array.from({ length: 10 }, () => CHARS[randomInt(CHARS.length)]).join("");

/**
 * Turns an admitted application into a real student, the same way a class
 * teacher's "Add student" does: a QubeEx student ID, a temporary password the
 * student must change on first login, and an enrollment in the chosen section
 * for the current session. Login is by student ID, so the user gets a
 * placeholder email (siblings can share a parent's real email).
 */
export async function createAdmittedStudent(input: {
  institutionId: string;
  standardId: string;
  divisionId: string;
  childName: string;
  dob: string | null;
  gender: string | null;
  details: Details;
  rollNo: string | null;
}) {
  const { institutionId, standardId, divisionId, details } = input;
  const plainPassword = tempPassword();
  const hashed = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
  const guardians = [
    details.fatherName ? { name: details.fatherName, number: details.phone, relation: "Father" } : null,
    details.motherName ? { name: details.motherName, number: details.altPhone || details.phone, relation: "Mother" } : null,
    details.guardianName ? { name: details.guardianName, number: details.phone, relation: "Guardian" } : null,
  ].filter((g): g is { name: string; number: string; relation: string } => !!g);
  const pii = buildStudentPIIUpdate({
    phone: details.phone || undefined,
    address: details.address || undefined,
    city: details.city || undefined,
    pincode: details.pincode || undefined,
    guardians: guardians.length ? guardians : undefined,
  });
  // Asked for the school bus: they wait on Transport → Waiting list until given a bus.
  const bus = busNeed(details.transport);
  const studentData = (userId: string, studentId: string) => ({
    studentId, userId, institutionId, standardId, divisionId,
    dob: input.dob ?? undefined,
    gender: input.gender ?? undefined,
    bloodGroup: details.bloodGroup || undefined,
    religion: details.religion || undefined,
    category: details.category || undefined,
    rollNo: input.rollNo ?? undefined,
    country: "India",
    tempPassword: plainPassword,
    joinedAt: new Date(),
    ...(bus.need ? { extraDetailFields: { [BUS_REQUEST_KEY]: bus.area || "Yes" } } : {}),
    ...pii,
  });

  const acad = academicDb();
  if (acad === prisma) {
    const student = await prisma.$transaction(async (tx) => {
      const studentId = await generateUserId(institutionId, "S", tx);
      const email = `${studentId.toLowerCase().replace(/-/g, "")}@students.qubeex.local`;
      const user = await tx.user.create({ data: { name: input.childName, email, password: hashed, role: "STUDENT", institutionId, isActive: true, mustChangePassword: true } });
      await recordUserStatusEvent(tx, { userId: user.id, institutionId, isActive: true });
      const created = await tx.student.create({ data: studentData(user.id, studentId) });
      await upsertCurrentEnrollment(institutionId, { studentId: created.id, standardId, divisionId, status: "ACTIVE" }, tx);
      return created;
    });
    return { student, tempPassword: plainPassword };
  }
  // BYOD: the user lives centrally, the student in the school's own database.
  const studentId = await generateUserId(institutionId, "S");
  const email = `${studentId.toLowerCase().replace(/-/g, "")}@students.qubeex.local`;
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: { name: input.childName, email, password: hashed, role: "STUDENT", institutionId, isActive: true, mustChangePassword: true } });
    await recordUserStatusEvent(tx, { userId: u.id, institutionId, isActive: true });
    return u;
  });
  const student = await acad.student.create({ data: studentData(user.id, studentId) });
  await upsertCurrentEnrollment(institutionId, { studentId: student.id, standardId, divisionId, status: "ACTIVE" }, acad);
  return { student, tempPassword: plainPassword };
}

/** Next free roll number in a section: one more than the highest numeric roll number. */
export async function nextRollNo(institutionId: string, divisionId: string) {
  const rows = await academicDb().student.findMany({
    where: { institutionId, divisionId, status: { notIn: ["WITHDRAWN", "GRADUATED"] } },
    select: { rollNo: true },
  });
  const max = rows.reduce((m, r) => Math.max(m, Number.parseInt(r.rollNo ?? "", 10) || 0), 0);
  return String(max + 1);
}
