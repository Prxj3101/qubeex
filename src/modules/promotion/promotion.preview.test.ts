import request from "supertest";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { seedPromotionFixtures, teardownPromotionFixtures, PromotionFixtures } from "./promotion.testHelpers";

describe("GET /api/teacher/promotions/divisions/:divisionId/preview", () => {
  let fx: PromotionFixtures;

  beforeAll(async () => {
    fx = await seedPromotionFixtures();
  });

  afterAll(async () => {
    await teardownPromotionFixtures(fx.institutionId);
    await prisma.$disconnect();
  });

  it("returns the roster and next-standard target divisions for the class teacher", async () => {
    const res = await request(app)
      .get(`/api/teacher/promotions/divisions/${fx.division5AId}/preview`)
      .set("Authorization", `Bearer ${fx.teacherToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.students).toHaveLength(2);
    expect(res.body.data.isGraduationEligible).toBe(false);
    expect(res.body.data.targets).toEqual([
      expect.objectContaining({ divisionId: fx.division6AId, name: "A" }),
    ]);
  });

  it("rejects a teacher who is not the class teacher of the division", async () => {
    const res = await request(app)
      .get(`/api/teacher/promotions/divisions/${fx.division5AId}/preview`)
      .set("Authorization", `Bearer ${fx.otherTeacherToken}`);

    expect(res.status).toBe(403);
  });

  it("allows an admin regardless of class-teacher assignment", async () => {
    const res = await request(app)
      .get(`/api/admin/promotions/divisions/${fx.division5AId}/preview`)
      .set("Authorization", `Bearer ${fx.adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.students).toHaveLength(2);
  });
});
