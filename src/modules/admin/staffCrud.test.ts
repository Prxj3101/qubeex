import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Staff CRUD", () => {
  const suffix = `${Date.now()}-staff-crud`;
  let institutionId: string;
  let adminToken: string;
  let teacherUserId: string;

  beforeAll(async () => {
    const institution = await prisma.institution.create({
      data: {
        name: `Staff CRUD Test ${suffix}`, email: `staff-crud-${suffix}@example.com`,
        type: "SCHOOL", institutionCode: `STCD-${suffix.slice(-6)}`, userIdPrefix: "STCD", status: "ACTIVE",
      },
    });
    institutionId = institution.id;
    const adminUser = await prisma.user.create({
      data: { name: "Test Admin", email: `admin-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
    const teacherUser = await prisma.user.create({ data: { name: "Linkable Teacher", email: `t-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true } });
    teacherUserId = teacherUser.id;
    await prisma.teacher.create({ data: { teacherId: `SC-${suffix}`, userId: teacherUser.id, institutionId } });
  });

  afterAll(async () => {
    await prisma.staff.deleteMany({ where: { institutionId } });
    await prisma.teacher.deleteMany({ where: { institutionId } });
    await prisma.user.deleteMany({ where: { institutionId } });
    await prisma.institution.delete({ where: { id: institutionId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("finds a linkable profile by name search", async () => {
    const res = await request(app)
      .get(`/api/admin/payroll/staff/search-profiles?q=Linkable`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((p: { userId: string }) => p.userId === teacherUserId)).toBe(true);
  });

  it("creates a payroll-only staff member (no userId)", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/staff")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Ramesh Kumar", email: `ramesh-${suffix}@example.com`, phone: "9876543210", designation: "Peon", staffType: "HELPER" });
    expect(res.status).toBe(201);
    expect(res.body.data.userId).toBeNull();
    expect(res.body.data.staffType).toBe("HELPER");
  });

  it("creates a profile-linked staff member from a Teacher", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/staff")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Linkable Teacher", email: `t-${suffix}@example.com`, staffType: "TEACHER", userId: teacherUserId });
    expect(res.status).toBe(201);
    expect(res.body.data.userId).toBe(teacherUserId);
  });

  it("rejects linking the same userId to a second Staff row", async () => {
    const res = await request(app)
      .post("/api/admin/payroll/staff")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Dup Link", email: `dup-${suffix}@example.com`, staffType: "TEACHER", userId: teacherUserId });
    expect(res.status).toBe(409);
  });

  it("lists all staff for the institution", async () => {
    const res = await request(app)
      .get("/api/admin/payroll/staff")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects linking a userId that belongs to a different institution", async () => {
    const otherInst = await prisma.institution.create({
      data: { name: `Cross Tenant Inst ${suffix}`, email: `xtenant-${suffix}@example.com`, type: "SCHOOL", institutionCode: `XTEN-${suffix.slice(-6)}`, userIdPrefix: "XTEN", status: "ACTIVE" },
    });
    const foreignUser = await prisma.user.create({
      data: { name: "Foreign User", email: `foreign-${suffix}@example.com`, role: "TEACHER", institutionId: otherInst.id, isActive: true },
    });
    const res = await request(app)
      .post("/api/admin/payroll/staff")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Foreign User", email: `foreign-${suffix}@example.com`, staffType: "TEACHER", userId: foreignUser.id });
    expect(res.status).toBe(404);

    await prisma.user.delete({ where: { id: foreignUser.id } });
    await prisma.institution.delete({ where: { id: otherInst.id } });
  });

  it("404s for a staff member in another institution", async () => {
    const otherInst = await prisma.institution.create({
      data: { name: `Other Inst ${suffix}`, email: `other-${suffix}@example.com`, type: "SCHOOL", institutionCode: `OTST-${suffix.slice(-6)}`, userIdPrefix: "OTST", status: "ACTIVE" },
    });
    const otherStaff = await prisma.staff.create({
      data: { institutionId: otherInst.id, name: "Other Staff", email: `os-${suffix}@example.com`, staffType: "HELPER" },
    });
    const res = await request(app)
      .patch(`/api/admin/payroll/staff/${otherStaff.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Hacked" });
    expect(res.status).toBe(404);
    await prisma.staff.deleteMany({ where: { institutionId: otherInst.id } });
    await prisma.institution.delete({ where: { id: otherInst.id } });
  });
});
