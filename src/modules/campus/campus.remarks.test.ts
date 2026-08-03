import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("POST /api/admin/campus/divisions/:divisionId/students/:studentId/remarks", () => {
  let institutionId: string;
  let divisionId: string;
  let studentId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-ARM-${suffix}`,
        name: `Test Institution ARM ${suffix}`,
        email: `test-arm-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class ARM ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-arm-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-arm-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-ARM-${suffix}`, userId: studentUser.id, institutionId, standardId: standard.id, divisionId, rollNo: "1" },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentRemark.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("creates a remark with reportedByRole 'Admin'", async () => {
    const res = await request(app)
      .post(`/api/admin/campus/divisions/${divisionId}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ severity: "HIGH", category: "Academic Dishonesty", title: "Copying in exam", detail: "Caught with notes." });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      type: "red",
      severity: "high",
      category: "Academic Dishonesty",
      title: "Copying in exam",
      reportedBy: "Test Admin",
      role: "Admin",
      status: "open",
    });
  });

  it("404s for a student not in the given division", async () => {
    const otherStandard = await prisma.standard.create({
      data: { institutionId, name: `Other ${Date.now()}`, order: 2 },
    });
    const otherDivision = await prisma.division.create({
      data: { standardId: otherStandard.id, institutionId, name: "B" },
    });

    const res = await request(app)
      .post(`/api/admin/campus/divisions/${otherDivision.id}/students/${studentId}/remarks`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ severity: "HIGH", category: "Test", title: "T", detail: "D" });

    expect(res.status).toBe(404);
  });
});
