// src/modules/teacher/teacher.reports.test.ts
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { computeDefaultAcademicYearWindow } from "../../utils/academicYear";

describe("Report review flow: /reports/inbox, /reports/submitted, PATCH /reports/:remarkId", () => {
  let institutionId: string;
  let academicYearId: string;
  let divisionId: string;
  let studentId: string;
  let classTeacherToken: string;
  let classTeacherUserId: string;
  let subjectTeacherToken: string;
  let unrelatedTeacherToken: string;
  let adminToken: string;
  let openRemarkId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-RPT-${suffix}`,
        name: `Test Institution RPT ${suffix}`,
        email: `test-rpt-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const academicYear = await prisma.academicYear.create({
      data: { institutionId, ...computeDefaultAcademicYearWindow(), isCurrent: true, status: "ACTIVE" },
    });
    academicYearId = academicYear.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class RPT ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-rpt-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const classTeacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `class-teacher-rpt-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    classTeacherUserId = classTeacherUser.id;
    const classTeacher = await prisma.teacher.create({
      data: { teacherId: `TCH-RPT-CT-${suffix}`, userId: classTeacherUser.id, institutionId },
    });
    await prisma.divisionAssignment.create({
      data: { academicYearId, divisionId, subjectId: null, teacherId: classTeacher.id, institutionId },
    });
    classTeacherToken = jwt.sign({ userId: classTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const subjectTeacherUser = await prisma.user.create({
      data: { name: "Subject Teacher", email: `subject-teacher-rpt-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const subjectTeacher = await prisma.teacher.create({
      data: { teacherId: `TCH-RPT-ST-${suffix}`, userId: subjectTeacherUser.id, institutionId },
    });
    const subject = await prisma.subject.create({
      data: { standardId: standard.id, institutionId, name: `Maths RPT ${suffix}`, order: 1 },
    });
    await prisma.divisionAssignment.create({
      data: { academicYearId, divisionId, subjectId: subject.id, teacherId: subjectTeacher.id, institutionId },
    });
    subjectTeacherToken = jwt.sign({ userId: subjectTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const unrelatedTeacherUser = await prisma.user.create({
      data: { name: "Unrelated Teacher", email: `unrelated-teacher-rpt-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    await prisma.teacher.create({
      data: { teacherId: `TCH-RPT-UN-${suffix}`, userId: unrelatedTeacherUser.id, institutionId },
    });
    unrelatedTeacherToken = jwt.sign({ userId: unrelatedTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-rpt-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-RPT-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;

    // Filed by the subject teacher; auto-routed to the class teacher.
    const createRes = await request(app)
      .post(`/api/teacher/classes/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${subjectTeacherToken}`)
      .send({ severity: "MEDIUM", category: "Discipline", title: "Talking in class", detail: "Disrupted the lesson." });
    openRemarkId = createRes.body.data.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentRemark.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.academicYear.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("auto-routes the report to the class teacher, not the reporting subject teacher", async () => {
    const remark = await prisma.studentRemark.findUnique({ where: { id: openRemarkId } });
    expect(remark?.assignedToUserId).toBe(classTeacherUserId);
  });

  it("shows the report in the class teacher's inbox but not an unrelated teacher's", async () => {
    const inboxRes = await request(app)
      .get("/api/teacher/reports/inbox")
      .set("Authorization", `Bearer ${classTeacherToken}`);
    expect(inboxRes.status).toBe(200);
    expect(inboxRes.body.data.some((r: { id: string }) => r.id === openRemarkId)).toBe(true);

    const unrelatedInboxRes = await request(app)
      .get("/api/teacher/reports/inbox")
      .set("Authorization", `Bearer ${unrelatedTeacherToken}`);
    expect(unrelatedInboxRes.status).toBe(200);
    expect(unrelatedInboxRes.body.data.some((r: { id: string }) => r.id === openRemarkId)).toBe(false);
  });

  it("shows the report in the subject teacher's 'submitted' history", async () => {
    const res = await request(app)
      .get("/api/teacher/reports/submitted")
      .set("Authorization", `Bearer ${subjectTeacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((r: { id: string }) => r.id === openRemarkId)).toBe(true);
  });

  it("rejects review from a teacher who is neither the assignee nor an admin", async () => {
    const res = await request(app)
      .patch(`/api/teacher/reports/${openRemarkId}`)
      .set("Authorization", `Bearer ${unrelatedTeacherToken}`)
      .send({ status: "UNDER_REVIEW" });
    expect(res.status).toBe(403);
  });

  it("404s reviewing a nonexistent report", async () => {
    const res = await request(app)
      .patch(`/api/teacher/reports/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${classTeacherToken}`)
      .send({ status: "UNDER_REVIEW" });
    expect(res.status).toBe(404);
  });

  it("lets the assigned class teacher move the report to under review", async () => {
    const res = await request(app)
      .patch(`/api/teacher/reports/${openRemarkId}`)
      .set("Authorization", `Bearer ${classTeacherToken}`)
      .send({ status: "UNDER_REVIEW", reviewRemark: "Looking into it." });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "under_review",
      reviewRemark: "Looking into it.",
      reviewedBy: "Class Teacher",
    });
  });

  it("lets the admin resolve the report regardless of assignment", async () => {
    const res = await request(app)
      .patch(`/api/admin/campus/reports/${openRemarkId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "RESOLVED", reviewRemark: "Spoke to the student." });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("resolved");
  });

  it("rejects re-reviewing an already-closed report", async () => {
    const res = await request(app)
      .patch(`/api/teacher/reports/${openRemarkId}`)
      .set("Authorization", `Bearer ${classTeacherToken}`)
      .send({ status: "REJECTED" });
    expect(res.status).toBe(409);
  });

  it("admin's inbox includes every institution report, not just ones assigned to them", async () => {
    const res = await request(app)
      .get("/api/admin/campus/reports/inbox")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((r: { id: string }) => r.id === openRemarkId)).toBe(true);
  });
});
