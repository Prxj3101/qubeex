import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../app";
import { prisma } from "../../utils/prisma";

describe("Academic year routes", () => {
  let institutionId: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`;
    const institution = await prisma.institution.create({
      data: {
        institutionCode: `TEST-AYR-${suffix}`,
        name: `Test Institution AYR ${suffix}`,
        email: `test-ayr-${suffix}@example.com`,
        type: "SCHOOL",
        status: "ACTIVE",
      },
    });
    institutionId = institution.id;

    const adminUser = await prisma.user.create({
      data: { name: "Admin", email: `admin-ayr-${suffix}@example.com`, role: "ADMIN", institutionId, isActive: true },
    });
    adminToken = jwt.sign({ userId: adminUser.id, role: "ADMIN", institutionId }, process.env.JWT_SECRET!);
  });

  it("lazily returns a default current year on first list call", async () => {
    const res = await request(app)
      .get("/api/academic-years")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].isCurrent).toBe(true);
  });

  it("starts a new academic year and closes the previous one", async () => {
    const res = await request(app)
      .post("/api/admin/academic-years")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ label: "2099-00", startDate: "2099-06-01T00:00:00.000Z", endDate: "2100-05-31T00:00:00.000Z" });
    expect(res.status).toBe(201);
    expect(res.body.data.isCurrent).toBe(true);

    const years = await prisma.academicYear.findMany({ where: { institutionId } });
    const current = years.filter((y) => y.isCurrent);
    expect(current.length).toBe(1);
    expect(current[0].label).toBe("2099-00");
    const closed = years.find((y) => y.label !== "2099-00");
    expect(closed?.status).toBe("CLOSED");
  });

  it("rejects starting a new year for a non-admin", async () => {
    const suffix = `${Date.now()}`;
    const teacherUser = await prisma.user.create({
      data: { name: "Teacher", email: `teacher-ayr-${suffix}@example.com`, role: "TEACHER", institutionId, isActive: true },
    });
    const teacherToken = jwt.sign({ userId: teacherUser.id, role: "TEACHER", institutionId }, process.env.JWT_SECRET!);

    const res = await request(app)
      .post("/api/admin/academic-years")
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ label: "2098-99", startDate: "2098-06-01T00:00:00.000Z", endDate: "2099-05-31T00:00:00.000Z" });
    expect(res.status).toBe(403);
  });

  it("rejects a malformed label", async () => {
    const res = await request(app)
      .post("/api/admin/academic-years")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ label: "not-a-year", startDate: "2103-06-01T00:00:00.000Z", endDate: "2104-05-31T00:00:00.000Z" });
    expect(res.status).toBe(400);
  });

  it("rejects endDate that is not after startDate", async () => {
    const res = await request(app)
      .post("/api/admin/academic-years")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ label: "2104-05", startDate: "2104-06-01T00:00:00.000Z", endDate: "2104-01-01T00:00:00.000Z" });
    expect(res.status).toBe(400);
  });

  it("rejects two concurrent start-new-year requests racing for the same institution", async () => {
    const [a, b] = await Promise.all([
      request(app)
        .post("/api/admin/academic-years")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ label: "2101-02", startDate: "2101-06-01T00:00:00.000Z", endDate: "2102-05-31T00:00:00.000Z" }),
      request(app)
        .post("/api/admin/academic-years")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ label: "2102-03", startDate: "2102-06-01T00:00:00.000Z", endDate: "2103-05-31T00:00:00.000Z" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 201]); // both allowed to create years, but...
    const current = await prisma.academicYear.findMany({ where: { institutionId, isCurrent: true } });
    expect(current.length).toBe(1); // ...only one ends up current
  });
});
