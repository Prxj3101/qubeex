import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("GET /admin/campus/divisions/:divisionId/leaderboard", () => {
  let institutionId: string;
  let divisionId: string;
  let studentAId: string;
  let studentBId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-LB-${suffix}`,
        name: `Test Institution LB ${suffix}`,
        email: `test-lb-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class LB ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const subject = await prisma.subject.create({
      data: { institutionId, standardId: standard.id, name: "Science", order: 1 },
    });

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-lb-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-lb-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({
      data: { teacherId: `TCH-LB-${suffix}`, userId: teacherUser.id, institutionId },
    });

    const studentAUser = await prisma.user.create({
      data: { name: "Student A", email: `student-a-lb-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentA = await prisma.student.create({
      data: { studentId: `STD-LBA-${suffix}`, userId: studentAUser.id, institutionId, divisionId, standardId: standard.id, rollNo: "01", status: "ACTIVE" },
    });
    studentAId = studentA.id;

    const studentBUser = await prisma.user.create({
      data: { name: "Student B", email: `student-b-lb-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const studentB = await prisma.student.create({
      data: { studentId: `STD-LBB-${suffix}`, userId: studentBUser.id, institutionId, divisionId, standardId: standard.id, rollNo: "02", status: "ACTIVE" },
    });
    studentBId = studentB.id;

    const marksheet = await prisma.marksheet.create({
      data: {
        institutionId, divisionId, createdByTeacherId: teacher.id,
        academicYear: "2025-26", status: "PUBLISHED", shareToken: `share-lb-${suffix}`,
      },
    });
    // One offline column (no "online" in the name) and one online column, each 50 max
    const offlineCol = await prisma.marksheetExamColumn.create({
      data: { marksheetId: marksheet.id, subjectId: subject.id, institutionId, name: "Unit Test", maxMarks: 50, createdByTeacherId: teacher.id },
    });
    const onlineCol = await prisma.marksheetExamColumn.create({
      data: { marksheetId: marksheet.id, subjectId: subject.id, institutionId, name: "Online Quiz", maxMarks: 50, createdByTeacherId: teacher.id },
    });

    // Student A: 40/50 offline, 10/50 online → combined 50/100 = 50%, offline 80%, online 20%
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, examColumnId: offlineCol.id, studentId: studentAId, institutionId, score: 40, enteredByTeacherId: teacher.id },
    });
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, examColumnId: onlineCol.id, studentId: studentAId, institutionId, score: 10, enteredByTeacherId: teacher.id },
    });

    // Student B: 10/50 offline, 40/50 online → combined 50/100 = 50%, offline 20%, online 80%
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, examColumnId: offlineCol.id, studentId: studentBId, institutionId, score: 10, enteredByTeacherId: teacher.id },
    });
    await prisma.marksheetScore.create({
      data: { marksheetId: marksheet.id, examColumnId: onlineCol.id, studentId: studentBId, institutionId, score: 40, enteredByTeacherId: teacher.id },
    });
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.marksheetScore.deleteMany({ where: { institutionId } });
    await prisma.marksheetExamColumn.deleteMany({ where: { institutionId } });
    await prisma.marksheet.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("computes combined/offline/online percentages correctly using the online-name heuristic", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/leaderboard`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const entries: { id: string; combinedPct: number; offlinePct: number | null; onlinePct: number | null }[] = res.body.data;
    expect(entries).toHaveLength(2);

    const a = entries.find((e) => e.id === studentAId)!;
    const b = entries.find((e) => e.id === studentBId)!;

    expect(a.combinedPct).toBe(50);
    expect(a.offlinePct).toBe(80);
    expect(a.onlinePct).toBe(20);

    expect(b.combinedPct).toBe(50);
    expect(b.offlinePct).toBe(20);
    expect(b.onlinePct).toBe(80);
  });

  it("both tied-combined students get consecutive ranks with no gap", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/leaderboard`)
      .set("Authorization", `Bearer ${adminToken}`);

    const ranks = (res.body.data as { rank: number }[]).map((e) => e.rank).sort();
    expect(ranks).toEqual([1, 2]);
  });
});
