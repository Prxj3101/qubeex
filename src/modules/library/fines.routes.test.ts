import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "lib1", institutionId: "school-a", role: "SUB_ADMIN" }; next();
} }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));
const mockUser = { findMany: jest.fn() };
jest.mock("../../utils/prisma", () => ({ prisma: { user: mockUser } }));
const mockFine = { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() };
jest.mock("../../utils/academicContext", () => ({ academicDb: () => ({ libraryFine: mockFine }) }));

import { authMiddleware } from "../../middlewares/auth.middleware";
import { logAudit } from "../../services/audit.service";
import { finesRouter } from "./fines.routes";

const app = express();
app.use(express.json()); app.use("/f", authMiddleware(), finesRouter); app.use(errorHandler);
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { jest.clearAllMocks(); mockFine.updateMany.mockResolvedValue({ count: 1 }); mockUser.findMany.mockResolvedValue([]); });

test("listing is scoped to the school and filters by status and member", async () => {
  mockFine.findMany.mockResolvedValue([]); mockFine.count.mockResolvedValue(0);
  const res = await request(app).get("/f?status=PENDING&userId=user1");
  expect(res.status).toBe(200);
  expect(mockFine.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", status: "PENDING", borrowerUserId: "user1" });
});

test("an invalid status filter is rejected", async () => {
  expect((await request(app).get("/f?status=BOGUS")).status).toBe(400);
});

test("collecting a pending fine marks it paid with who and when", async () => {
  mockFine.findFirst.mockResolvedValue({ id, status: "PENDING", collectedVia: "LIBRARIAN" });
  expect((await request(app).post(`/f/${id}/collect`)).status).toBe(200);
  const call = mockFine.updateMany.mock.calls[0][0];
  expect(call.where).toEqual({ id, institutionId: "school-a", status: "PENDING" });
  expect(call.data).toMatchObject({ status: "PAID", collectedById: "lib1" });
  expect(call.data.paidAt).toBeInstanceOf(Date);
  expect(logAudit).toHaveBeenCalledWith("LIBRARY_FINE_COLLECTED", expect.anything());
});

test("a fine added to fees can also be marked paid once the fees desk has received it", async () => {
  mockFine.findFirst.mockResolvedValue({ id, status: "PENDING", collectedVia: "FEES" });
  expect((await request(app).post(`/f/${id}/collect`)).status).toBe(200);
});

test("collecting twice, or collecting a waived fine, is a conflict", async () => {
  for (const status of ["PAID", "WAIVED"]) {
    mockFine.findFirst.mockResolvedValue({ id, status, collectedVia: "LIBRARIAN" });
    expect((await request(app).post(`/f/${id}/collect`)).status).toBe(409);
  }
  expect(mockFine.updateMany).not.toHaveBeenCalled();
});

test("a lost race on collect is a conflict", async () => {
  mockFine.findFirst.mockResolvedValue({ id, status: "PENDING", collectedVia: "LIBRARIAN" });
  mockFine.updateMany.mockResolvedValue({ count: 0 });
  expect((await request(app).post(`/f/${id}/collect`)).status).toBe(409);
});

test("an unknown fine is 404 for collect and waive", async () => {
  mockFine.findFirst.mockResolvedValue(null);
  expect((await request(app).post(`/f/${id}/collect`)).status).toBe(404);
  expect((await request(app).post(`/f/${id}/waive`).send({ reason: "Illness" })).status).toBe(404);
  expect(mockFine.findFirst.mock.calls[0][0].where).toEqual({ id, institutionId: "school-a" });
});

test("waiving needs a reason of 1 to 200 characters", async () => {
  mockFine.findFirst.mockResolvedValue({ id, status: "PENDING", collectedVia: "LIBRARIAN" });
  for (const body of [{}, { reason: "  " }, { reason: "x".repeat(201) }]) {
    expect((await request(app).post(`/f/${id}/waive`).send(body)).status).toBe(400);
  }
  expect(mockFine.updateMany).not.toHaveBeenCalled();
});

test("waiving records the reason and audits", async () => {
  mockFine.findFirst.mockResolvedValue({ id, status: "PENDING", collectedVia: "LIBRARIAN" });
  expect((await request(app).post(`/f/${id}/waive`).send({ reason: "  Hospitalised  " })).status).toBe(200);
  expect(mockFine.updateMany.mock.calls[0][0].data).toMatchObject({ status: "WAIVED", waivedReason: "Hospitalised", collectedById: "lib1" });
  expect(logAudit).toHaveBeenCalledWith("LIBRARY_FINE_WAIVED", expect.anything());
});

test("a paid fine cannot be waived", async () => {
  mockFine.findFirst.mockResolvedValue({ id, status: "PAID", collectedVia: "LIBRARIAN" });
  expect((await request(app).post(`/f/${id}/waive`).send({ reason: "x" })).status).toBe(409);
});

test("listed fines carry the member's name and code, looked up within the school", async () => {
  mockFine.findMany.mockResolvedValue([{ id: "f1", borrowerUserId: "u1", amountPaise: 600 }, { id: "f2", borrowerUserId: "gone", amountPaise: 100 }]);
  mockFine.count.mockResolvedValue(2);
  mockUser.findMany.mockResolvedValue([{ id: "u1", name: "Asha", displayId: "S001" }]);
  const res = await request(app).get("/f");
  expect(res.body.data.items[0].member).toEqual({ name: "Asha", code: "S001" });
  expect(res.body.data.items[1].member).toEqual({ name: "Unknown", code: null });
  expect(mockUser.findMany.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a", id: { in: ["u1", "gone"] } });
});
