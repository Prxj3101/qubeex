import jwt from "jsonwebtoken";
import { prisma } from "../../utils/prisma";

export interface PromotionFixtures {
  institutionId: string;
  standard5Id: string;
  standard6Id: string;
  division5AId: string;
  division6AId: string;
  teacherId: string;
  teacherUserId: string;
  studentIds: string[];
  adminToken: string;
  teacherToken: string;
  otherTeacherToken: string;
}

let counter = 0;

export async function seedPromotionFixtures(): Promise<PromotionFixtures> {
  counter += 1;
  const suffix = `${Date.now()}-${counter}`;

  const institution = await prisma.institution.create({
    data: {
      institutionCode: `TEST-PROMO-${suffix}`,
      name: `Test Institution ${suffix}`,
      email: `test-promo-${suffix}@example.com`,
      type: "SCHOOL",
      status: "ACTIVE",
    },
  });

  const standard5 = await prisma.standard.create({
    data: { institutionId: institution.id, name: `Class 5 ${suffix}`, order: 5 },
  });
  const standard6 = await prisma.standard.create({
    data: { institutionId: institution.id, name: `Class 6 ${suffix}`, order: 6 },
  });

  const division5A = await prisma.division.create({
    data: { standardId: standard5.id, institutionId: institution.id, name: "A", capacity: 2 },
  });
  const division6A = await prisma.division.create({
    data: { standardId: standard6.id, institutionId: institution.id, name: "A", capacity: 2 },
  });

  const adminUser = await prisma.user.create({
    data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId: institution.id, isActive: true },
  });

  const teacherUser = await prisma.user.create({
    data: { name: "Test Teacher", email: `teacher-${suffix}@example.com`, role: "TEACHER", institutionId: institution.id, isActive: true },
  });
  const teacher = await prisma.teacher.create({
    data: { teacherId: `TCH-${suffix}`, userId: teacherUser.id, institutionId: institution.id },
  });
  await prisma.divisionAssignment.create({
    data: { divisionId: division5A.id, subjectId: null, teacherId: teacher.id, institutionId: institution.id },
  });

  const otherTeacherUser = await prisma.user.create({
    data: { name: "Other Teacher", email: `other-teacher-${suffix}@example.com`, role: "TEACHER", institutionId: institution.id, isActive: true },
  });
  await prisma.teacher.create({
    data: { teacherId: `TCH2-${suffix}`, userId: otherTeacherUser.id, institutionId: institution.id },
  });

  const studentIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const studentUser = await prisma.user.create({
      data: { name: `Student ${i} ${suffix}`, email: `student-${i}-${suffix}@example.com`, role: "STUDENT", institutionId: institution.id, isActive: true },
    });
    const student = await prisma.student.create({
      data: {
        studentId: `STU-${suffix}-${i}`,
        userId: studentUser.id,
        institutionId: institution.id,
        standardId: standard5.id,
        divisionId: division5A.id,
        rollNo: String(i + 1),
      },
    });
    studentIds.push(student.id);
  }

  const sign = (userId: string, role: string) =>
    jwt.sign({ userId, role, institutionId: institution.id }, process.env.JWT_SECRET!);

  return {
    institutionId: institution.id,
    standard5Id: standard5.id,
    standard6Id: standard6.id,
    division5AId: division5A.id,
    division6AId: division6A.id,
    teacherId: teacher.id,
    teacherUserId: teacherUser.id,
    studentIds,
    adminToken: sign(adminUser.id, "ADMIN"),
    teacherToken: sign(teacherUser.id, "TEACHER"),
    otherTeacherToken: sign(otherTeacherUser.id, "TEACHER"),
  };
}

export async function teardownPromotionFixtures(institutionId: string): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { institutionId } });
  await prisma.studentEnrollment.deleteMany({ where: { institutionId } });
  await prisma.promotionBatch.deleteMany({ where: { institutionId } });
  await prisma.student.deleteMany({ where: { institutionId } });
  await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
  await prisma.teacher.deleteMany({ where: { institutionId } });
  await prisma.division.deleteMany({ where: { institutionId } });
  await prisma.standard.deleteMany({ where: { institutionId } });
  await prisma.user.deleteMany({ where: { institutionId } });
  await prisma.institution.delete({ where: { id: institutionId } });
}
