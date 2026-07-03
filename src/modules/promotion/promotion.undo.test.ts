import request from "supertest";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { seedPromotionFixtures, teardownPromotionFixtures, PromotionFixtures } from "./promotion.testHelpers";

describe("POST /api/teacher/promotions/batches/:batchId/undo", () => {
  let fx: PromotionFixtures;

  beforeAll(async () => {
    fx = await seedPromotionFixtures();
  });

  afterAll(async () => {
    await teardownPromotionFixtures(fx.institutionId);
    await prisma.$disconnect();
  });

  it("restores prior state and deletes enrollment rows", async () => {
    const promoteRes = await request(app)
      .post(`/api/teacher/promotions/divisions/${fx.division5AId}`)
      .set("Authorization", `Bearer ${fx.teacherToken}`)
      .send({ studentIds: fx.studentIds, action: "PROMOTE", targetDivisionId: fx.division6AId });
    const batchId = promoteRes.body.data.batchId;

    const undoRes = await request(app)
      .post(`/api/teacher/promotions/batches/${batchId}/undo`)
      .set("Authorization", `Bearer ${fx.teacherToken}`);

    expect(undoRes.status).toBe(200);
    expect(undoRes.body.data.restoredCount).toBe(2);

    const restored = await prisma.student.findMany({ where: { id: { in: fx.studentIds } } });
    expect(restored.every((s) => s.standardId === fx.standard5Id && s.divisionId === fx.division5AId)).toBe(true);

    const remainingEnrollments = await prisma.studentEnrollment.findMany({ where: { promotionBatchId: batchId } });
    expect(remainingEnrollments).toHaveLength(0);
  });

  it("rejects undoing the same batch twice", async () => {
    const promoteRes = await request(app)
      .post(`/api/teacher/promotions/divisions/${fx.division5AId}`)
      .set("Authorization", `Bearer ${fx.teacherToken}`)
      .send({ studentIds: fx.studentIds, action: "PROMOTE", targetDivisionId: fx.division6AId });
    const batchId = promoteRes.body.data.batchId;

    await request(app)
      .post(`/api/teacher/promotions/batches/${batchId}/undo`)
      .set("Authorization", `Bearer ${fx.teacherToken}`);

    const secondUndo = await request(app)
      .post(`/api/teacher/promotions/batches/${batchId}/undo`)
      .set("Authorization", `Bearer ${fx.teacherToken}`);

    expect(secondUndo.status).toBe(409);
  });
});
