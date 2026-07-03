import request from "supertest";
import app from "../../app";
import { prisma } from "../../utils/prisma";
import { seedPromotionFixtures, teardownPromotionFixtures, PromotionFixtures } from "./promotion.testHelpers";

describe("GET /api/admin/promotions/batches", () => {
  let fx: PromotionFixtures;

  beforeAll(async () => {
    fx = await seedPromotionFixtures();
    await request(app)
      .post(`/api/admin/promotions/divisions/${fx.division5AId}`)
      .set("Authorization", `Bearer ${fx.adminToken}`)
      .send({ studentIds: fx.studentIds, action: "PROMOTE", targetDivisionId: fx.division6AId });
  });

  afterAll(async () => {
    await teardownPromotionFixtures(fx.institutionId);
    await prisma.$disconnect();
  });

  it("lists batches for the institution, most recent first", async () => {
    const res = await request(app)
      .get("/api/admin/promotions/batches")
      .set("Authorization", `Bearer ${fx.adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].fromDivisionId).toBe(fx.division5AId);
  });

  it("filters by divisionId query param", async () => {
    const res = await request(app)
      .get("/api/admin/promotions/batches")
      .query({ divisionId: fx.division6AId })
      .set("Authorization", `Bearer ${fx.adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});
