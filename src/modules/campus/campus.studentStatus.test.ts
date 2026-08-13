import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("PATCH /admin/campus/divisions/:divisionId/students/:studentId", () => {
  let institutionId: string;
  let divisionId: string;
  let studentId: string;
  let studentUserId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-STA-${suffix}`,
        name: `Test Institution STA ${suffix}`,
        email: `test-sta-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class STA ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-sta-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-sta-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    studentUserId = studentUser.id;
    const student = await prisma.student.create({
      data: { studentId: `STD-STA-${suffix}`, userId: studentUser.id, institutionId, divisionId, standardId: standard.id, rollNo: "01", status: "ACTIVE" },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.userStatusEvent.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("deactivates a student and flips the linked User.isActive to false", async () => {
    const res = await request(app)
      .patch(`/api/admin/campus/divisions/${divisionId}/students/${studentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "INACTIVE" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("INACTIVE");

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    expect(student?.status).toBe("INACTIVE");
    const user = await prisma.user.findUnique({ where: { id: studentUserId } });
    expect(user?.isActive).toBe(false);
  });

  it("re-activates a student and flips User.isActive back to true", async () => {
    const res = await request(app)
      .patch(`/api/admin/campus/divisions/${divisionId}/students/${studentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "ACTIVE" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ACTIVE");

    const user = await prisma.user.findUnique({ where: { id: studentUserId } });
    expect(user?.isActive).toBe(true);
  });

  it("rejects an invalid status value", async () => {
    const res = await request(app)
      .patch(`/api/admin/campus/divisions/${divisionId}/students/${studentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "GRADUATED" });

    expect(res.status).toBe(400);
  });
});
