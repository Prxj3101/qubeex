import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { deleteInstitution } from "../superadmin/superadmin.service";

// Regression coverage for the final-review fix wave: deletion cascades must know
// about the year-scoped tables, and teacher reassignment must not rewrite a
// prior academic year's DivisionAssignment row.
describe("Academic-year-aware cascades and assignment scoping", () => {
  let institutionId: string;
  let standardId: string;
  let adminToken: string;
  let teacherAId: string;
  let teacherBId: string;
  let oldYearId: string;
  const suffix = `${Date.now()}`;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-AYC-${suffix}`,
        name: `Test Institution AYC ${suffix}`,
        email: `test-ayc-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const oldYear = await prisma.academicYear.create({
      data: { institutionId, label: "2090-91", startDate: new Date(2090, 5, 1), endDate: new Date(2091, 4, 31), isCurrent: true },
    });
    oldYearId = oldYear.id;

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class AYC ${suffix}`, order: 1 } });
    standardId = standard.id;

    const adminUser = await prisma.user.create({
      data: { name: "Admin", email: `admin-ayc-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const tUserA = await prisma.user.create({
      data: { name: "Teacher A", email: `ta-ayc-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const tUserB = await prisma.user.create({
      data: { name: "Teacher B", email: `tb-ayc-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    teacherAId = (await prisma.teacher.create({ data: { teacherId: `TCH-AYC-A-${suffix}`, userId: tUserA.id, institutionId } })).id;
    teacherBId = (await prisma.teacher.create({ data: { teacherId: `TCH-AYC-B-${suffix}`, userId: tUserB.id, institutionId } })).id;
  });

  afterAll(async () => {
    // deleteInstitution (last test) normally removes everything; this is only a
    // fallback if an earlier assertion failed before it ran.
    const stillThere = institutionId && (await prisma.institution.findUnique({ where: { id: institutionId } }));
    if (stillThere) {
      await deleteInstitution(institutionId).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("reassigning a subject teacher after a rollover creates a new-year row and leaves the prior year's row intact", async () => {
    const division = await prisma.division.create({ data: { standardId, institutionId, name: `A-${suffix}` } });
    const subject = await prisma.subject.create({ data: { institutionId, standardId, name: "Maths", order: 1 } });
    await prisma.divisionSubject.create({ data: { divisionId: division.id, subjectId: subject.id, institutionId } });

    const first = await request(app)
      .post(`/api/admin/campus/divisions/${division.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: teacherAId, subjectId: subject.id });
    expect(first.status).toBe(201);

    const rollover = await request(app)
      .post("/api/admin/academic-years")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ label: "2091-92", startDate: "2091-06-01T00:00:00.000Z", endDate: "2092-05-31T00:00:00.000Z" });
    expect(rollover.status).toBe(201);
    const newYearId = rollover.body.data.id as string;

    const second = await request(app)
      .post(`/api/admin/campus/divisions/${division.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ teacherId: teacherBId, subjectId: subject.id });
    expect(second.status).toBe(201);

    const rows = await prisma.divisionAssignment.findMany({
      where: { divisionId: division.id, subjectId: subject.id, institutionId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.academicYearId === oldYearId)?.teacherId).toBe(teacherAId);
    expect(rows.find((r) => r.academicYearId === newYearId)?.teacherId).toBe(teacherBId);
  });

  it("deletes a division that has StudentEnrollment and DivisionTimetable rows", async () => {
    const division = await prisma.division.create({ data: { standardId, institutionId, name: `B-${suffix}` } });
    const sUser = await prisma.user.create({
      data: { name: "Student", email: `s-ayc-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    // The student has since moved on (no divisionId), but their enrollment
    // history still references this division.
    const student = await prisma.student.create({
      data: { studentId: `STU-AYC-${suffix}`, userId: sUser.id, institutionId, standardId },
    });
    await prisma.studentEnrollment.create({
      data: { institutionId, studentId: student.id, academicYearId: oldYearId, standardId, divisionId: division.id, status: "ACTIVE" },
    });
    await prisma.divisionTimetable.create({
      data: { institutionId, divisionId: division.id, academicYearId: oldYearId, timetableUrl: "https://example.com/tt.pdf" },
    });

    const res = await request(app)
      .delete(`/api/admin/campus/divisions/${division.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(await prisma.division.findUnique({ where: { id: division.id } })).toBeNull();
    expect(await prisma.studentEnrollment.count({ where: { divisionId: division.id } })).toBe(0);
    expect(await prisma.divisionTimetable.count({ where: { divisionId: division.id } })).toBe(0);
  });

  it("deletes an institution that has academic years, enrollments and timetables", async () => {
    const division = await prisma.division.create({ data: { standardId, institutionId, name: `C-${suffix}` } });
    const student = await prisma.student.findFirstOrThrow({ where: { institutionId } });
    const currentYear = await prisma.academicYear.findFirstOrThrow({ where: { institutionId, isCurrent: true } });
    await prisma.studentEnrollment.create({
      data: { institutionId, studentId: student.id, academicYearId: currentYear.id, standardId, divisionId: division.id, status: "ACTIVE" },
    });
    await prisma.divisionTimetable.create({
      data: { institutionId, divisionId: division.id, academicYearId: currentYear.id, timetableUrl: "https://example.com/tt2.pdf" },
    });

    // Before the fix this threw a P2003 FK violation (AcademicYear / enrollment rows left behind).
    await deleteInstitution(institutionId);
    expect(await prisma.institution.findUnique({ where: { id: institutionId } })).toBeNull();
    expect(await prisma.academicYear.count({ where: { institutionId } })).toBe(0);
    expect(await prisma.studentEnrollment.count({ where: { institutionId } })).toBe(0);
    expect(await prisma.divisionTimetable.count({ where: { institutionId } })).toBe(0);
  });
});
