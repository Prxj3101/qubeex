import request from "supertest";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { seedPromotionFixtures, teardownPromotionFixtures, PromotionFixtures } from "./promotion.testHelpers";

describe("POST /api/teacher/promotions/divisions/:divisionId", () => {
  let fx: PromotionFixtures;

  beforeAll(async () => {
    fx = await seedPromotionFixtures();
  });

  afterAll(async () => {
    await teardownPromotionFixtures(fx.institutionId);
    await prisma.$disconnect();
  });

  it("promotes selected students into the target division and records history", async () => {
    const res = await request(app)
      .post(`/api/teacher/promotions/divisions/${fx.division5AId}`)
      .set("Authorization", `Bearer ${fx.teacherToken}`)
      .send({ studentIds: fx.studentIds, action: "PROMOTE", targetDivisionId: fx.division6AId });

    expect(res.status).toBe(201);
    expect(res.body.data.promotedCount).toBe(2);

    const promoted = await prisma.student.findMany({ where: { id: { in: fx.studentIds } } });
    expect(promoted.every((s) => s.standardId === fx.standard6Id && s.divisionId === fx.division6AId)).toBe(true);

    const enrollments = await prisma.studentEnrollment.findMany({ where: { promotionBatchId: res.body.data.batchId } });
    expect(enrollments).toHaveLength(2);
    expect(enrollments.every((e) => e.outcome === "PROMOTED" && e.standardId === fx.standard5Id)).toBe(true);
  });

  it("rejects a studentId that does not belong to the source division", async () => {
    const res = await request(app)
      .post(`/api/teacher/promotions/divisions/${fx.division5AId}`)
      .set("Authorization", `Bearer ${fx.teacherToken}`)
      .send({ studentIds: ["nonexistent-id"], action: "PROMOTE", targetDivisionId: fx.division6AId });

    expect(res.status).toBe(400);
  });

  it("returns a capacity warning but still succeeds when the target exceeds capacity", async () => {
    const extraUser = await prisma.user.create({
      data: { name: "Extra", email: `extra-${Date.now()}@example.com`, role: "STUDENT", institutionId: fx.institutionId, isActive: true },
    });
    const extraStudent = await prisma.student.create({
      data: {
        studentId: `EXTRA-${Date.now()}`,
        userId: extraUser.id,
        institutionId: fx.institutionId,
        standardId: fx.standard5Id,
        divisionId: fx.division5AId,
      },
    });

    // division6A has capacity 2; two students were already promoted into it above.
    const res = await request(app)
      .post(`/api/admin/promotions/divisions/${fx.division5AId}`)
      .set("Authorization", `Bearer ${fx.adminToken}`)
      .send({ studentIds: [extraStudent.id], action: "PROMOTE", targetDivisionId: fx.division6AId });

    expect(res.status).toBe(201);
    expect(res.body.warning).toMatch(/capacity/i);
  });
});

describe("GRADUATE action", () => {
  let fx: PromotionFixtures;

  beforeAll(async () => {
    fx = await seedPromotionFixtures();
  });

  afterAll(async () => {
    await teardownPromotionFixtures(fx.institutionId);
    await prisma.$disconnect();
  });

  it("graduates selected students on the highest standard and records history", async () => {
    const gradUser = await prisma.user.create({
      data: { name: "Grad Candidate", email: `grad-${Date.now()}@example.com`, role: "STUDENT", institutionId: fx.institutionId, isActive: true },
    });
    const gradStudent = await prisma.student.create({
      data: {
        studentId: `GRAD-${Date.now()}`,
        userId: gradUser.id,
        institutionId: fx.institutionId,
        standardId: fx.standard6Id,
        divisionId: fx.division6AId,
        rollNo: "1",
      },
    });

    const res = await request(app)
      .post(`/api/admin/promotions/divisions/${fx.division6AId}`)
      .set("Authorization", `Bearer ${fx.adminToken}`)
      .send({ studentIds: [gradStudent.id], action: "GRADUATE" });

    expect(res.status).toBe(201);
    expect(res.body.data.promotedCount).toBe(1);
    expect(res.body.data.action).toBe("GRADUATE");

    const graduated = await prisma.student.findUnique({ where: { id: gradStudent.id } });
    expect(graduated?.status).toBe("GRADUATED");
    expect(graduated?.standardId).toBe(fx.standard6Id);
    expect(graduated?.divisionId).toBe(fx.division6AId);

    const enrollments = await prisma.studentEnrollment.findMany({ where: { promotionBatchId: res.body.data.batchId } });
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0].outcome).toBe("GRADUATED");
  });

  it("rejects GRADUATE on a division that is not the highest standard", async () => {
    const res = await request(app)
      .post(`/api/admin/promotions/divisions/${fx.division5AId}`)
      .set("Authorization", `Bearer ${fx.adminToken}`)
      .send({ studentIds: fx.studentIds, action: "GRADUATE" });

    expect(res.status).toBe(400);
  });

  it("rejects PROMOTE on the highest standard", async () => {
    // targetDivisionId is provided (any value) so Zod's refine passes and the
    // request actually reaches the controller's standard-order guard, rather
    // than being rejected earlier by the schema's own missing-target check.
    const res = await request(app)
      .post(`/api/admin/promotions/divisions/${fx.division6AId}`)
      .set("Authorization", `Bearer ${fx.adminToken}`)
      .send({ studentIds: fx.studentIds, action: "PROMOTE", targetDivisionId: fx.division6AId });

    expect(res.status).toBe(400);
  });
});

describe("cross-institution isolation", () => {
  let fxA: PromotionFixtures;
  let fxB: PromotionFixtures;

  beforeAll(async () => {
    fxA = await seedPromotionFixtures();
    fxB = await seedPromotionFixtures();
  });

  afterAll(async () => {
    await teardownPromotionFixtures(fxA.institutionId);
    await teardownPromotionFixtures(fxB.institutionId);
    await prisma.$disconnect();
  });

  it("returns 404 when institution A's admin previews institution B's division", async () => {
    const res = await request(app)
      .get(`/api/admin/promotions/divisions/${fxB.division5AId}/preview`)
      .set("Authorization", `Bearer ${fxA.adminToken}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 when institution A's admin promotes students in institution B's division", async () => {
    const res = await request(app)
      .post(`/api/admin/promotions/divisions/${fxB.division5AId}`)
      .set("Authorization", `Bearer ${fxA.adminToken}`)
      .send({ studentIds: fxB.studentIds, action: "PROMOTE", targetDivisionId: fxB.division6AId });

    expect(res.status).toBe(404);
  });
});
