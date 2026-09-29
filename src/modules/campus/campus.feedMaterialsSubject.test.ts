import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { computeDefaultAcademicYearWindow } from "../../utils/academicYear";

describe("Campus feed materials — subjectId-based tagging", () => {
  let institutionId: string;
  let academicYearId: string;
  let divisionId: string;
  let mathsId: string;
  let scienceId: string;
  let classTeacherToken: string;
  let mathsTeacherToken: string;
  let scienceTeacherToken: string;
  let studentToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-MAT-${suffix}`,
        name: `Test Institution Materials ${suffix}`,
        email: `test-mat-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const academicYear = await prisma.academicYear.create({
      data: { institutionId, ...computeDefaultAcademicYearWindow(), isCurrent: true, status: "ACTIVE" },
    });
    academicYearId = academicYear.id;

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class ${suffix}`, order: 1 } });
    const division = await prisma.division.create({ data: { standardId: standard.id, institutionId, name: "A" } });
    divisionId = division.id;

    const maths = await prisma.subject.create({ data: { institutionId, standardId: standard.id, name: "Maths", order: 1 } });
    const science = await prisma.subject.create({ data: { institutionId, standardId: standard.id, name: "Science", order: 2 } });
    mathsId = maths.id;
    scienceId = science.id;

    const classTeacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `ct-mat-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const classTeacher = await prisma.teacher.create({ data: { teacherId: `TCH-CT-MAT-${suffix}`, userId: classTeacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId, subjectId: null, teacherId: classTeacher.id, institutionId } });
    classTeacherToken = jwt.sign({ userId: classTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const mathsTeacherUser = await prisma.user.create({
      data: { name: "Maths Teacher", email: `maths-mat-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const mathsTeacher = await prisma.teacher.create({ data: { teacherId: `TCH-MATHS-${suffix}`, userId: mathsTeacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId, subjectId: mathsId, teacherId: mathsTeacher.id, institutionId } });
    mathsTeacherToken = jwt.sign({ userId: mathsTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const scienceTeacherUser = await prisma.user.create({
      data: { name: "Science Teacher", email: `sci-mat-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const scienceTeacher = await prisma.teacher.create({ data: { teacherId: `TCH-SCI-${suffix}`, userId: scienceTeacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { academicYearId, divisionId, subjectId: scienceId, teacherId: scienceTeacher.id, institutionId } });
    scienceTeacherToken = jwt.sign({ userId: scienceTeacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-mat-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    await prisma.student.create({
      data: { studentId: `STU-MAT-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentToken = jwt.sign({ userId: studentUser.id, role: "STUDENT", institutionId }, process.env.JWT_SECRET!);
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    // createPost now also notifies the division's audience (notification.service.ts),
    // which creates NotificationRecipient rows referencing these users — must
    // clear those before the user deleteMany below, or it hits the same FK
    // violation the SubAdmin/User delete flows hit for the same reason.
    await prisma.notificationRecipient.deleteMany({ where: { institutionId } });
    await prisma.campusFeedPost.deleteMany({ where: { institutionId } });
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

  it("lets a subject teacher post material tagged with their own subject", async () => {
    const res = await request(app)
      .post("/api/teacher/campus/feed/posts")
      .set("Authorization", `Bearer ${mathsTeacherToken}`)
      .send({ type: "MATERIAL", title: "Algebra notes", divisionId, subjectId: mathsId });
    expect(res.status).toBe(201);
    expect(res.body.data.subjectId).toBe(mathsId);
    expect(res.body.data.subject).toBe("Maths");
  });

  it("rejects a subject teacher tagging a subject they don't teach", async () => {
    const res = await request(app)
      .post("/api/teacher/campus/feed/posts")
      .set("Authorization", `Bearer ${mathsTeacherToken}`)
      .send({ type: "MATERIAL", title: "Wrong subject", divisionId, subjectId: scienceId });
    expect(res.status).toBe(400);
  });

  it("lets the class teacher post material for any subject in their class", async () => {
    const res = await request(app)
      .post("/api/teacher/campus/feed/posts")
      .set("Authorization", `Bearer ${classTeacherToken}`)
      .send({ type: "MATERIAL", title: "Science extra reading", divisionId, subjectId: scienceId });
    expect(res.status).toBe(201);
    expect(res.body.data.subjectId).toBe(scienceId);
  });

  it("lets the class teacher post a general material with no subject", async () => {
    const res = await request(app)
      .post("/api/teacher/campus/feed/posts")
      .set("Authorization", `Bearer ${classTeacherToken}`)
      .send({ type: "MATERIAL", title: "Class circular", divisionId });
    expect(res.status).toBe(201);
    expect(res.body.data.subjectId).toBeNull();
  });

  it("groups materials by subjectId and surfaces subject-less ones as general for students", async () => {
    const res = await request(app)
      .get("/api/student/class")
      .set("Authorization", `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    const mathsMaterials = res.body.data.subjectMaterials[mathsId];
    const scienceMaterials = res.body.data.subjectMaterials[scienceId];
    expect(mathsMaterials.some((m: { title: string }) => m.title === "Algebra notes")).toBe(true);
    expect(scienceMaterials.some((m: { title: string }) => m.title === "Science extra reading")).toBe(true);
    expect(res.body.data.generalMaterials.some((m: { title: string }) => m.title === "Class circular")).toBe(true);
  });
});
