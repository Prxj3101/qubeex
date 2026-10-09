import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, res: any, next: any) => {
  if (req.headers["x-role"] === "TEACHER") return res.sendStatus(403);
  req.user = { institutionId: "school-a", role: req.headers["x-role"] || "ADMIN" }; next();
} }));
jest.mock("../../middlewares/institutionAccess.middleware", () => ({ institutionAccessMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock("../../middlewares/academicRouting.middleware", () => ({ academicRoutingMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock("../../middlewares/requirePermission.middleware", () => ({ requirePermission: () => (req: any, res: any, next: any) => req.user.role === "SUB_ADMIN" ? res.sendStatus(403) : next() }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));
jest.mock("../../utils/academicContext", () => ({ academicDb: () => ({ inventoryCategory: mockCategory }) }));
const mockCategory = { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() };
import router from "./inventory.routes";
const app = express();
app.use(express.json()); app.use("/inventory", router); app.use(errorHandler);
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => jest.clearAllMocks());
test("lists only the authenticated school's categories", async () => {
  mockCategory.findMany.mockResolvedValue([]);
  expect((await request(app).get("/inventory/categories")).status).toBe(200);
  expect(mockCategory.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a" });
});
test("normalises names and preserves institution ownership", async () => {
  mockCategory.create.mockResolvedValue({ id });
  expect((await request(app).post("/inventory/categories").send({ name: "  Lab   Equipment ", description: " test " })).status).toBe(201);
  expect(mockCategory.create.mock.calls[0][0].data).toEqual({ name: "Lab Equipment", nameKey: "lab equipment", description: "test", institutionId: "school-a" });
});
test("rejects invalid names and injected institution IDs", async () => {
  for (const body of [{ name: " " }, { name: "x".repeat(81) }, { name: "Test", institutionId: "school-b" }]) {
    expect((await request(app).post("/inventory/categories").send(body)).status).toBe(400);
  }
  expect(mockCategory.create).not.toHaveBeenCalled();
});
test("duplicate names return conflict", async () => {
  mockCategory.create.mockRejectedValue({ code: "P2002" });
  expect((await request(app).post("/inventory/categories").send({ name: "Test" })).status).toBe(409);
});
test("updates cannot target another school", async () => {
  mockCategory.updateMany.mockResolvedValue({ count: 0 });
  expect((await request(app).patch(`/inventory/categories/${id}`).send({ name: "Test" })).status).toBe(404);
  expect(mockCategory.updateMany.mock.calls[0][0].where).toEqual({ id, institutionId: "school-a" });
});
test("deletes are scoped and reject missing categories", async () => {
  mockCategory.deleteMany.mockResolvedValue({ count: 0 });
  expect((await request(app).delete(`/inventory/categories/${id}`)).status).toBe(404);
  expect(mockCategory.deleteMany.mock.calls[0][0].where).toEqual({ id, institutionId: "school-a" });
});
test("teachers and unpermitted subadmins cannot read categories", async () => {
  for (const role of ["TEACHER", "SUB_ADMIN"]) expect((await request(app).get("/inventory/categories").set("x-role", role)).status).toBe(403);
  expect(mockCategory.findMany).not.toHaveBeenCalled();
});
