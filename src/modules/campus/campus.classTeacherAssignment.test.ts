import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Class-teacher single-assignment invariant", () => {
  let institutionId: string;
  let divisionAId: string;
  let divisionBId: string;
  let teacherId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-CT-${suffix}`,
        name: `Test Institution CT ${suffix}`,
        email: `test-ct-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class CT ${suffix}`, order: 1 },
    });
    const divisionA = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    const divisionB = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "B" },
    });
    divisionAId = divisionA.id;
    divisionBId = divisionB.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-ct-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-ct-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({
      data: { teacherId: `TCH-CT-${suffix}`, userId: teacherUser.id, institutionId },
    });
    teacherId = teacher.id;

    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.divisionSubject.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    // The assignTeacher endpoint now resolves/creates the institution's
    // current AcademicYear row (see campus.controller.ts assignTeacher) —
    // must be cleared before the institution itself, or the FK constraint
    // on AcademicYear.institutionId blocks the delete below.
    await prisma.academicYear.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("rejects assigning a teacher as class teacher of a second division via POST /assign", async () => {
    const first = await request(app)
      .post(`/api/admin/campus/divisions/${divisionAId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId, subjectId: null });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/admin/campus/divisions/${divisionBId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId, subjectId: null });

    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);

    const divisionB = await prisma.division.findUnique({ where: { id: divisionBId } });
    expect(divisionB?.classTeacherId).not.toBe(teacherId);
  });

  it("rejects assigning a teacher as class teacher of a second division via PATCH /class-teacher", async () => {
    await prisma.division.update({ where: { id: divisionAId }, data: { classTeacherId: teacherId } });
    await prisma.division.update({ where: { id: divisionBId }, data: { classTeacherId: null } });

    const attempt = await request(app)
      .patch(`/api/admin/campus/divisions/${divisionBId}/class-teacher`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId });

    expect(attempt.status).toBe(409);
    expect(attempt.body.success).toBe(false);

    const divisionB = await prisma.division.findUnique({ where: { id: divisionBId } });
    expect(divisionB?.classTeacherId).toBeNull();
  });

  it("keeps DivisionAssignment in sync when PATCH /class-teacher assigns a class teacher", async () => {
    await prisma.division.updateMany({ where: { institutionId }, data: { classTeacherId: null } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId, subjectId: null } });

    const res = await request(app)
      .patch(`/api/admin/campus/divisions/${divisionAId}/class-teacher`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId });

    expect(res.status).toBe(200);

    const assignment = await prisma.divisionAssignment.findFirst({
      where: { divisionId: divisionAId, subjectId: null },
    });
    expect(assignment?.teacherId).toBe(teacherId);
  });

  it("still allows the same teacher to be a SUBJECT teacher in multiple divisions", async () => {
    const subject = await prisma.subject.create({
      data: { institutionId, standardId: (await prisma.division.findUnique({ where: { id: divisionAId } }))!.standardId, name: "Maths", order: 1 },
    });
    await prisma.divisionSubject.createMany({
      data: [
        { divisionId: divisionAId, subjectId: subject.id, institutionId },
        { divisionId: divisionBId, subjectId: subject.id, institutionId },
      ],
    });

    const firstSubjectAssign = await request(app)
      .post(`/api/admin/campus/divisions/${divisionAId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId, subjectId: subject.id });
    expect(firstSubjectAssign.status).toBe(201);

    const secondSubjectAssign = await request(app)
      .post(`/api/admin/campus/divisions/${divisionBId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId, subjectId: subject.id });
    expect(secondSubjectAssign.status).toBe(201);
  });
});
