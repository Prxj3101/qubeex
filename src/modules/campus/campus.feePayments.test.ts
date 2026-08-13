import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Fee payments: GET and PATCH /admin/campus/divisions/:divisionId/fee-payments", () => {
  let institutionId: string;
  let divisionId: string;
  let studentId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;

    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-FP-${suffix}`,
        name: `Test Institution FP ${suffix}`,
        email: `test-fp-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const standard = await prisma.standard.create({
      data: { institutionId, name: `Class FP ${suffix}`, order: 1 },
    });
    const division = await prisma.division.create({
      data: { standardId: standard.id, institutionId, name: "A" },
    });
    divisionId = division.id;

    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-fp-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);

    const studentUser = await prisma.user.create({
      data: { name: "Test Student", email: `student-fp-${suffix}@example.com`, role: "STUDENT", institutionId, isActive: true },
    });
    const student = await prisma.student.create({
      data: { studentId: `STD-FP-${suffix}`, userId: studentUser.id, institutionId, divisionId, standardId: standard.id, rollNo: "01" },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    if (!institutionId) { await prisma.$disconnect(); return; }
    await prisma.studentFeePayment.deleteMany({ where: { institutionId } });
    await prisma.student.deleteMany({ where: { institutionId } });
    await prisma.division.deleteMany({ where: { institutionId } });
    await prisma.standard.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } });
    await prisma.$disconnect();
  });

  it("returns an empty list before any payment is recorded", async () => {
    const res = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/fee-payments`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("creates a fee payment record via PATCH and returns it via GET", async () => {
    const create = await request(app)
      .patch(`/api/admin/campus/divisions/${divisionId}/fee-payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId, feeMonthId: "month-june", status: "PAID", paidDate: "2026-06-10" });

    expect(create.status).toBe(200);
    expect(create.body.data).toMatchObject({ studentId, feeMonthId: "month-june", status: "PAID", paidDate: "2026-06-10" });

    const list = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/fee-payments`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ studentId, feeMonthId: "month-june", status: "PAID", paidDate: "2026-06-10" });
  });

  it("upserts (updates in place) rather than duplicating on a second PATCH for the same month", async () => {
    await request(app)
      .patch(`/api/admin/campus/divisions/${divisionId}/fee-payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId, feeMonthId: "month-june", status: "PENDING", paidDate: null });

    const list = await request(app)
      .get(`/api/admin/campus/divisions/${divisionId}/fee-payments`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ studentId, feeMonthId: "month-june", status: "PENDING", paidDate: null });
  });

  it("404s when the student doesn't belong to this division", async () => {
    const res = await request(app)
      .patch(`/api/admin/campus/divisions/${divisionId}/fee-payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: "00000000-0000-0000-0000-000000000000", feeMonthId: "month-july", status: "PAID", paidDate: null });

    expect(res.status).toBe(404);
  });
});
