import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Attendance summary — cumulative % from start of academic session", () => {
  let institutionId: string;
  let divisionId: string;
  let teacherToken: string;
  let adminToken: string;
  let studentId: string;
  let startYear: number;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-ATT-${suffix}`,
        name: `Test Institution Attendance ${suffix}`,
        email: `test-att-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class ${suffix}`, order: 1 } });
    const division = await prisma.division.create({ data: { standardId: standard.id, institutionId, name: "A" } });
    divisionId = division.id;

    const teacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `teacher-att-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-ATT-${suffix}`, userId: teacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { divisionId, subjectId: null, teacherId: teacher.id, institutionId } });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const adminUser = await prisma.user.create({
      data: { name: "Admin", email: `admin-att-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-att-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-ATT-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;

    const now = new Date();
    startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;

    // Out-of-session record — well before the session start — must NOT be
    // included in the cumulative total (the bug this test guards against).
    await prisma.attendance.create({
      data: { institutionId, divisionId, studentId, date: `${startYear - 1}-01-15`, status: "A" },
    });

    // June (session start): 1 present, 1 absent -> month pct 50%, cumulative 50%.
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-06-01`, status: "P" } });
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-06-02`, status: "A" } });

    // July: 2 present -> month pct 100%, cumulative (1+2)/(2+2) = 75%.
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-07-01`, status: "P" } });
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-07-02`, status: "P" } });

    // A record marked present BEFORE this date was later declared a holiday.
    // It must be excluded from both the month % and the cumulative %, the
    // same way the sheet UI already excludes holiday cells from its totals.
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-06-03`, status: "P" } });
    await prisma.schoolHoliday.create({ data: { institutionId, date: `${startYear}-06-03`, name: "Test Holiday" } });

    // August: 1 present, 3 absent -> month pct 25%. This month has a
    // different number of records than June/July, so it distinguishes a
    // running-average-of-monthly-% cumulative (the correct behavior) from a
    // weighted running total of raw counts (which would give a different,
    // wrong answer here).
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-08-01`, status: "P" } });
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-08-02`, status: "A" } });
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-08-03`, status: "A" } });
    await prisma.attendance.create({ data: { institutionId, divisionId, studentId, date: `${startYear}-08-04`, status: "A" } });
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.schoolHoliday.deleteMany({ where: { institutionId } });
    await prisma.attendance.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("teacher summary: excludes out-of-session data and accumulates June->July correctly", async () => {
    const res = await request(app)
      .get(`/api/teacher/attendance/${divisionId}/summary`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);

    const student = res.body.data.students.find((s: { studentId: string }) => s.studentId === studentId);
    expect(student).toBeDefined();

    const june = student.monthlyStats.find((m: { monthKey: string }) => m.monthKey === `${startYear}-06`);
    const july = student.monthlyStats.find((m: { monthKey: string }) => m.monthKey === `${startYear}-07`);
    const august = student.monthlyStats.find((m: { monthKey: string }) => m.monthKey === `${startYear}-08`);
    // June has a 3rd present record on a date later declared a holiday — it
    // must be excluded, so June still totals only 1 present + 1 absent.
    expect(june.p).toBe(1);
    expect(june.pct).toBe(50);
    expect(june.cumulativePct).toBe(50);
    expect(july.pct).toBe(100);
    // Cumulative = running average of each month's own % (50, then 100),
    // not a weighted total of raw record counts.
    expect(july.cumulativePct).toBe(75);
    expect(august.pct).toBe(25);
    expect(august.cumulativePct).toBe(58); // round((50 + 100 + 25) / 3) = 58.33 -> 58

    // "Overall" is the cumulative through the latest month with data (August).
    expect(student.overallPct).toBe(58);

    // The out-of-session January record must not appear at all.
    const staleMonth = student.monthlyStats.find((m: { monthKey: string }) => m.monthKey === `${startYear - 1}-01`);
    expect(staleMonth).toBeUndefined();
  });

  it("admin summary: same cumulative logic via the shared campus controller", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/attendance/summary`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const student = res.body.data.students.find((s: { studentId: string }) => s.studentId === studentId);
    expect(student).toBeDefined();

    const june = student.monthlyStats.find((m: { monthKey: string }) => m.monthKey === `${startYear}-06`);
    const july = student.monthlyStats.find((m: { monthKey: string }) => m.monthKey === `${startYear}-07`);
    const august = student.monthlyStats.find((m: { monthKey: string }) => m.monthKey === `${startYear}-08`);
    expect(june.cumulativePct).toBe(50);
    expect(july.cumulativePct).toBe(75);
    expect(august.cumulativePct).toBe(58);
    expect(student.overallPct).toBe(58);
  });
});
