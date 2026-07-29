import request from "supertest";
import jwt from "jsonwebtoken";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse");
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Marksheet PDF download — horizontal pagination for wide sheets", () => {
  let institutionId: string;
  let divisionId: string;
  let marksheetId: string;
  let teacherToken: string;
  // 20 subjects is enough to overflow both the full-sheet layout (3 columns
  // per subject) and the exam-wise layout (1 column per subject) on a single
  // landscape A4 page, so both PDF generators' horizontal pagination gets
  // exercised.
  const subjectNames = Array.from({ length: 20 }, (_, i) => `Subject ${i + 1}`);
  const studentNames = ["Aarav Mehta", "Zara Khan"];

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-PDF-${suffix}`,
        name: `Test Institution PDF ${suffix}`,
        email: `test-pdf-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({ data: { institutionId, name: `Class ${suffix}`, order: 1 } });
    const division = await prisma.division.create({ data: { standardId: standard.id, institutionId, name: "A" } });
    divisionId = division.id;

    const teacherUser = await prisma.user.create({
      data: { name: "Class Teacher", email: `teacher-pdf-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `TCH-PDF-${suffix}`, userId: teacherUser.id, institutionId } });
    await prisma.divisionAssignment.create({ data: { divisionId, subjectId: null, teacherId: teacher.id, institutionId } });
    teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    // 10 subjects x 1 exam column each = 10 exam cols + 10 subtotal + 10 subpct
    // + 3 overall cols = 33 columns total — enough to overflow a single
    // landscape A4 page at a readable minimum column width.
    const subjects = await Promise.all(
      subjectNames.map((name, i) => prisma.subject.create({ data: { institutionId, standardId: standard.id, name, order: i } }))
    );

    const marksheet = await prisma.marksheet.create({
      data: {
        institutionId,
        divisionId,
        createdByTeacherId: teacher.id,
        academicYear: "2026-27",
        status: "PUBLISHED",
        shareToken: `share-pdf-${suffix}`,
      },
    });
    marksheetId = marksheet.id;

    const examColumns = await Promise.all(
      subjects.map((sub) =>
        prisma.marksheetExamColumn.create({
          data: {
            marksheetId,
            subjectId: sub.id,
            institutionId,
            name: "Unit Test",
            maxMarks: 50,
            createdByTeacherId: teacher.id,
          },
        })
      )
    );

    const students = await Promise.all(
      studentNames.map((name, i) =>
        prisma.user
          .create({ data: { name, email: `student-pdf-${i}-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true } })
          .then((u) =>
            prisma.student.create({
              data: { studentId: `STU-PDF-${i}-${suffix}`, userId: u.id, institutionId, standardId: standard.id, divisionId, rollNo: `${i + 1}` },
            })
          )
      )
    );

    for (const col of examColumns) {
      for (const student of students) {
        await prisma.marksheetScore.create({
          data: {
            marksheetId,
            examColumnId: col.id,
            studentId: student.id,
            institutionId,
            score: 40,
            enteredByTeacherId: teacher.id,
          },
        });
      }
    }
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.marksheetScore.deleteMany({ where: { institutionId } });
    await prisma.marksheetExamColumn.deleteMany({ where: { institutionId } });
    await prisma.marksheet.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.subject.deleteMany({ where: { institutionId } });
    await prisma.divisionAssignment.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("splits a wide full marksheet across multiple pages instead of cutting columns off", async () => {
    const res = await request(app)
      .get(`/api/teacher/marksheet/${marksheetId}/download`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);

    const pdf = await pdfParse(res.body as Buffer);
    // More than one page proves the sheet was split horizontally rather than
    // squeezed into (and cut off from) a single page.
    expect(pdf.numpages).toBeGreaterThan(1);

    // Every subject name and every student name must appear somewhere across
    // the full PDF — nothing should be silently dropped.
    for (const name of subjectNames) {
      expect(pdf.text).toContain(name);
    }
    for (const name of studentNames) {
      expect(pdf.text).toContain(name);
    }
    // The overall summary columns must still be present (not pushed off-page).
    expect(pdf.text).toContain("Grand");
  });

  it("splits a wide exam-wise marksheet across multiple pages too", async () => {
    const res = await request(app)
      .get(`/api/teacher/marksheet/${marksheetId}/download?scope=exam`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);

    const pdf = await pdfParse(res.body as Buffer);
    expect(pdf.numpages).toBeGreaterThan(1);
    for (const name of subjectNames) {
      expect(pdf.text).toContain(name);
    }
  });
});
