import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Teacher Salary Structure assignment", () => {
  const suffix = `${Date.now()}-payroll-struct`;
  let institutionId: string;
  let adminToken: string;
  let teacherId: string;
  let templateId: string;
  let otherInstitutionId: string;
  let otherTeacherId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Payroll Struct Test ${suffix}`, email: `payroll-struct-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYST-${suffix.slice(-6)}`, userIdPrefix: "PYST", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({
      data: { name: "Test Teacher", email: `teacher-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacher = await prisma.teacher.create({ data: { teacherId: `PST-${suffix}`, userId: teacherUser.id, institutionId } });
    teacherId = teacher.id;
    const template = await prisma.salaryTemplate.create({
      data: { institutionId, name: `Tpl ${suffix}`, earnings: [{ label: "Basic", amount: 20000 }], deductions: [] },
    });
    templateId = template.id;

    // Second institution, with a real teacher, to prove cross-tenant isolation
    const otherInstitution = await prisma.institution.create({
      data: {
        name: `Payroll Struct Other ${suffix}`, email: `payroll-struct-other-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `PYSO-${suffix.slice(-6)}`, userIdPrefix: "PYSO", status: "ACTIVE",
      },
    });
    otherInstitutionId = otherInstitution.id;
    const otherTeacherUser = await prisma.user.create({
      data: { name: "Other Teacher", email: `other-teacher-${suffix}@example.com`, role: "TEACHER", institutionId: otherInstitutionId, isActive: true },
    });
    const otherTeacher = await prisma.teacher.create({ data: { teacherId: `OST-${suffix}`, userId: otherTeacherUser.id, institutionId: otherInstitutionId } });
    otherTeacherId = otherTeacher.id;
  });

  afterAll(async () => {
    await prisma.teacherSalaryStructure.deleteMany({ where: { institutionId } });
    await prisma.salaryTemplate.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});

    await prisma.teacherSalaryStructure.deleteMany({ where: { institutionId: otherInstitutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId: otherInstitutionId } });
    await prisma.user.deleteMany({ where: { institutionId: otherInstitutionId } });
    await prisma.institution.delete({ where: { id: otherInstitutionId } }).catch(() => {});

    await prisma.$disconnect();
  });

  it("returns null structure before one is assigned", async () => {
    const res = await request(app)
      .get(`/api/admin/payroll/teachers/${teacherId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("creates a structure from a template", async () => {
    const res = await request(app)
      .put(`/api/admin/payroll/teachers/${teacherId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        templateId,
        earnings: [{ label: "Basic", amount: 20000 }],
        deductions: [],
        bankDetails: { accountName: "Test Teacher", accountNumber: "1234", ifsc: "TEST0001", bankName: "Test Bank" },
        effectiveFrom: "2026-09-01T00:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.earnings[0].amount).toBe(20000);
    expect(res.body.data.bankDetails.ifsc).toBe("TEST0001");
  });

  it("replaces the structure on a second PUT (upsert, not duplicate)", async () => {
    const res = await request(app)
      .put(`/api/admin/payroll/teachers/${teacherId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ templateId: null, earnings: [{ label: "Basic", amount: 25000 }], deductions: [], effectiveFrom: "2026-09-01T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body.data.earnings[0].amount).toBe(25000);
    const count = await prisma.teacherSalaryStructure.count({ where: { teacherId } });
    expect(count).toBe(1);
  });

  it("404s for a teacher id that doesn't exist at all", async () => {
    const res = await request(app)
      .get(`/api/admin/payroll/teachers/does-not-exist/structure`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("404s on GET for a real teacher belonging to a different institution", async () => {
    const res = await request(app)
      .get(`/api/admin/payroll/teachers/${otherTeacherId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("404s on PUT for a real teacher belonging to a different institution", async () => {
    const res = await request(app)
      .put(`/api/admin/payroll/teachers/${otherTeacherId}/structure`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ earnings: [{ label: "Basic", amount: 10000 }], deductions: [], effectiveFrom: "2026-09-01T00:00:00.000Z" });
    expect(res.status).toBe(404);

    // Confirm no structure row leaked into the other institution's teacher
    const leaked = await prisma.teacherSalaryStructure.findFirst({ where: { teacherId: otherTeacherId } });
    expect(leaked).toBeNull();
  });
});
