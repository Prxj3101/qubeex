import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Admin promotion routes", () => {
  let institutionId: string;
  let standard5Id: string;
  let division5AId: string;
  let division6AId: string;
  let adminToken: string;
  let studentId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-APROMO-${suffix}`,
        name: `Test Institution APromo ${suffix}`,
        email: `test-apromo-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard5 = await prisma.standard.create({ data: { institutionId, name: `Class 5 ${suffix}`, order: 5 } });
    const standard6 = await prisma.standard.create({ data: { institutionId, name: `Class 6 ${suffix}`, order: 6 } });
    standard5Id = standard5.id;

    const division5A = await prisma.division.create({ data: { standardId: standard5.id, institutionId, name: "A" } });
    const division6A = await prisma.division.create({ data: { standardId: standard6.id, institutionId, name: "A" } });
    division5AId = division5A.id;
    division6AId = division6A.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-apromo-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-apromo-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STU-APROMO-${suffix}`, userId: studentUser.id, institutionId, standardId: standard5Id, divisionId: division5AId, rollNo: "1" },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentPromotionOutcome.deleteMany({ where: { institutionId } });
    await prisma.promotionBatch.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("admin can preview and graduate a student with no class-teacher assignment needed", async () => {
    const preview = await request(app)
      .get(`/api/admin/promotions/divisions/${division5AId}/preview`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.students).toHaveLength(1);

    const res = await request(app)
      .post(`/api/admin/promotions/divisions/${division5AId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ outcomes: [{ studentId, outcome: "WITHDRAWN" }] });
    expect(res.status).toBe(200);

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    expect(student?.status).toBe("WITHDRAWN");
  });

  it("admin sees the batch institution-wide via list-batches", async () => {
    const res = await request(app)
      .get(`/api/admin/promotions/batches`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].counts.withdrawn).toBe(1);
  });
});
