import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../app";
import { prisma } from "./prisma";
import { computeDefaultAcademicYearWindow } from "./academicYear";

jest.mock("../services/storage.service", () => ({
  uploadImageToR2: jest.fn().mockResolvedValue({ publicUrl: "https://example.com/timetable.pdf" }),
  generateSignedAvatarUrl: jest.fn(),
  generateSignedAvatarUrlsBatch: jest.fn().mockResolvedValue(new Map()),
}));

describe("StudentEnrollment/DivisionTimetable writers (student create/move, timetable upload)", () => {
  let institutionId: string;
  let standardId: string;
  let standard2Id: string;
  let divisionAId: string;
  let divisionBId: string;
  let adminToken: string;
  let teacherToken: string;
  let teacherId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;
    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-ENRWRITE-${suffix}`,
        name: `Test Institution EnrWrite ${suffix}`,
        email: `test-enrwrite-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class EnrWrite ${suffix}`, order: 1 } });
    standardId = standard.id;
    const standard2 = await prisma.standard.create({ data: { institutionId, name: `Class EnrWrite2 ${suffix}`, order: 2 } });
    standard2Id = standard2.id;
    const divisionA = await prisma.division.create({ data: { standardId, institutionId, name: "A" } });
    const divisionB = await prisma.division.create({ data: { standardId, institutionId, name: "B" } });
    divisionAId = divisionA.id;
    divisionBId = divisionB.id;

    const adminUser = await prisma.user.create({
      data: { name: "Admin", email: `admin-enrwrite-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `teacher-enrwrite-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-ENRWRITE-${suffix}`, userId: teacherUser.id, institutionId } });
    teacherId = teacher.id;

    const window = computeDefaultAcademicYearWindow();
    const currentYear = await prisma.academicYear.create({
      data: { institutionId, label: `${window.label}-${suffix}`, startDate: window.startDate, endDate: window.endDate, isCurrent: true, status: "ACTIVE" },
    });

    await prisma.divisionAssignment.create({
      data: { divisionId: divisionAId, subjectId: null, teacherId, institutionId, academicYearId: currentYear.id },
    });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    await prisma.divisionTimetable.deleteMany({ where: { institutionId } });
    await prisma.studentEnrollment.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.userStatusEvent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.academicYear.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("creates a current-year StudentEnrollment when a teacher adds a student to their class", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${divisionAId}/students`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ name: "Teacher Added Student", rollNo: "1" });
    expect(res.status).toBe(201);

    const currentYear = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    expect(currentYear).not.toBeNull();

    const enrollment = await prisma.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId: res.body.data.student.id, academicYearId: currentYear!.id } },
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment!.divisionId).toBe(divisionAId);
    expect(enrollment!.status).toBe("ACTIVE");
  });

  it("creates a current-year StudentEnrollment when an admin adds a student with a division", async () => {
    const res = await request(app)
      .post("/api/admin/students")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Admin Added Student", email: `admin-added-${Date.now()}@example.com`, standardId, divisionId: divisionAId });
    expect(res.status).toBe(201);

    const currentYear = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    const enrollment = await prisma.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId: res.body.data.id, academicYearId: currentYear!.id } },
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment!.divisionId).toBe(divisionAId);
  });

  it("does not create a StudentEnrollment when an admin adds a student without a division yet", async () => {
    const res = await request(app)
      .post("/api/admin/students")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Unassigned Student", email: `admin-unassigned-${Date.now()}@example.com` });
    expect(res.status).toBe(201);

    const enrollment = await prisma.studentEnrollment.findFirst({ where: { studentId: res.body.data.id } });
    expect(enrollment).toBeNull();
  });

  it("updates the existing current-year StudentEnrollment in place when an admin moves a student to another division", async () => {
    const createRes = await request(app)
      .post("/api/admin/students")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Movable Student", email: `admin-move-${Date.now()}@example.com`, standardId, divisionId: divisionAId });
    const studentId = createRes.body.data.id as string;

    const moveRes = await request(app)
      .patch(`/api/admin/students/${studentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ divisionId: divisionBId });
    expect(moveRes.status).toBe(200);

    const currentYear = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    const enrollment = await prisma.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId, academicYearId: currentYear!.id } },
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment!.divisionId).toBe(divisionBId);

    // Updated in place, not duplicated.
    const count = await prisma.studentEnrollment.count({ where: { studentId } });
    expect(count).toBe(1);
  });

  it("creates a DivisionTimetable row for the current year when a class teacher uploads a timetable", async () => {
    const res = await request(app)
      .post(`/api/teacher/classes/${divisionAId}/timetable`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .attach("timetable", Buffer.from("fake-pdf-content"), "timetable.pdf");
    expect(res.status).toBe(200);

    const currentYear = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    const timetable = await prisma.divisionTimetable.findUnique({
      where: { divisionId_academicYearId: { divisionId: divisionAId, academicYearId: currentYear!.id } },
    });
    expect(timetable).not.toBeNull();
    expect(timetable!.timetableUrl).toBe("https://example.com/timetable.pdf");

    // Division.timetableUrl stays in sync as the fast "current" pointer.
    const division = await prisma.division.findUnique({ where: { id: divisionAId } });
    expect(division!.timetableUrl).toBe("https://example.com/timetable.pdf");
  });

  it("upserts the same DivisionTimetable row on a second upload in the same year", async () => {
    await request(app)
      .post(`/api/teacher/classes/${divisionAId}/timetable`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .attach("timetable", Buffer.from("fake-pdf-content-2"), "timetable2.pdf");

    const currentYear = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
    const count = await prisma.divisionTimetable.count({ where: { divisionId: divisionAId, academicYearId: currentYear!.id } });
    expect(count).toBe(1);
  });
});
