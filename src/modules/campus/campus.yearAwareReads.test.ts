import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

// Combines the scenarios from Task 3 (getDivision) and Task 4 (loadStandards /
// listStandards) briefs into a single test file sharing ONE institution, per
// the human partner's testing-policy instruction: don't spin up a fresh
// institution per test file. Two divisions are used under the shared
// institution/academic-years fixture set — one carrying the getDivision
// teacher-assignment fixtures, the other carrying the loadStandards
// headcount fixtures — so each scenario's setup stays exactly as described
// in its brief without the two concerns colliding in the same division.
describe("Campus year-aware reads — getDivision & loadStandards", () => {
  let institutionId: string;
  let adminToken: string;
  let currentYear: { id: string };
  let pastYearId: string;

  // getDivision fixtures
  let assignmentDivisionId: string;
  let currentYearTeacherId: string;
  let pastYearTeacherId: string;

  // loadStandards fixtures
  let headcountDivisionId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;
    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-YRAWARE-${suffix}`,
        name: `Test YrAware ${suffix}`,
        email: `yraware-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class YrAware ${suffix}`, order: 1 },
    });

    const assignmentDivision = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    assignmentDivisionId = assignmentDivision.id;

    const headcountDivision = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "B" },
    });
    headcountDivisionId = headcountDivision.id;

    const adminUser = await prisma.user.create({
      data: { name: "Admin YrAware", email: `admin-yraware-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    currentYear = await prisma.academicYear.create({
      data: { institutionId, label: `2026-27-${suffix}`, startDate: new Date(2026, 5, 1), endDate: new Date(2027, 4, 31), isCurrent: true, status: "ACTIVE" },
    });
    const pastYear = await prisma.academicYear.create({
      data: { institutionId, label: `2025-26-${suffix}`, startDate: new Date(2025, 5, 1), endDate: new Date(2026, 4, 31), isCurrent: false, status: "CLOSED" },
    });
    pastYearId = pastYear.id;

    // ── getDivision fixtures: current-year and past-year teacher assignments ──
    const currentTeacherUser = await prisma.user.create({
      data: { name: "Current Teacher", email: `current-teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const currentTeacher = await prisma.teacher.create({ data: { teacherId: `TCH-CUR-${suffix}`, userId: currentTeacherUser.id, institutionId } });
    currentYearTeacherId = currentTeacher.id;
    await prisma.divisionAssignment.create({
      data: { divisionId: assignmentDivisionId, subjectId: null, teacherId: currentTeacher.id, institutionId, academicYearId: currentYear.id },
    });

    const pastTeacherUser = await prisma.user.create({
      data: { name: "Past Teacher", email: `past-teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const pastTeacher = await prisma.teacher.create({ data: { teacherId: `TCH-PAST-${suffix}`, userId: pastTeacherUser.id, institutionId } });
    pastYearTeacherId = pastTeacher.id;
    await prisma.divisionAssignment.create({
      data: { divisionId: assignmentDivisionId, subjectId: null, teacherId: pastTeacher.id, institutionId, academicYearId: pastYearId },
    });

    // ── loadStandards fixtures: current-live student + past-only enrollments ──
    const currentUser = await prisma.user.create({
      data: { name: "Current Student", email: `current-stu-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    await prisma.student.create({
      data: { studentId: `STU-CUR-${suffix}`, userId: currentUser.id, institutionId, standardId: standard.id, divisionId: headcountDivisionId, status: "ACTIVE" },
    });

    for (let i = 0; i < 2; i++) {
      const pastUser = await prisma.user.create({
        data: { name: `Past Student ${i}`, email: `past-stu-${i}-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
      });
      // Note: no standardId/divisionId set on the live Student row here — these
      // students have since moved on from this division, so the live headcount
      // (which counts by Student.divisionId) must not include them. Their
      // presence in this division during the past year is captured solely via
      // the StudentEnrollment row below, which the historical headcount reads.
      const pastStudent = await prisma.student.create({
        data: { studentId: `STU-PAST-${i}-${suffix}`, userId: pastUser.id, institutionId },
      });
      await prisma.studentEnrollment.create({
        data: { institutionId, studentId: pastStudent.id, academicYearId: pastYearId, standardId: standard.id, divisionId: headcountDivisionId, status: "ACTIVE" },
      });
    }
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentEnrollment.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.academicYear.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("GET /admin/campus/divisions/:divisionId — academic year awareness", () => {
    it("returns only the current year's assignments when academicYearId is omitted (regression)", async () => {
      const res = await request(app)
        .get(`/api/admin/campus/divisions/${assignmentDivisionId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const teacherIds = res.body.data.assignments.map((a: { teacherId: string }) => a.teacherId);
      expect(teacherIds).toContain(currentYearTeacherId);
      expect(teacherIds).not.toContain(pastYearTeacherId);
    });

    it("returns only the requested past year's assignments when academicYearId is passed", async () => {
      const res = await request(app)
        .get(`/api/admin/campus/divisions/${assignmentDivisionId}`)
        .query({ academicYearId: pastYearId })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const teacherIds = res.body.data.assignments.map((a: { teacherId: string }) => a.teacherId);
      expect(teacherIds).toContain(pastYearTeacherId);
      expect(teacherIds).not.toContain(currentYearTeacherId);
    });
  });

  describe("GET /admin/campus/standards — academic year awareness", () => {
    it("shows the current live headcount when academicYearId is omitted (regression)", async () => {
      const res = await request(app)
        .get("/api/admin/campus/standards")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const allDivisions = res.body.data.flatMap((s: { divisions: { id: string }[] }) => s.divisions);
      const division = allDivisions.find((d: { id: string }) => d.id === headcountDivisionId);
      expect(division._count.students).toBe(1);
    });

    it("shows the historical headcount via StudentEnrollment when a past academicYearId is passed", async () => {
      const res = await request(app)
        .get("/api/admin/campus/standards")
        .query({ academicYearId: pastYearId })
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const allDivisions = res.body.data.flatMap((s: { divisions: { id: string }[] }) => s.divisions);
      const division = allDivisions.find((d: { id: string }) => d.id === headcountDivisionId);
      expect(division._count.students).toBe(2);
    });
  });
});
