import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "u1", institutionId: "school-a", role: "ADMIN" }; next();
} }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));

const mockBook = { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() };
const mockCopy = { findMany: jest.fn(), findFirst: jest.fn(), createMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() };
const mockLoan = { count: jest.fn() };
const db = { libraryBook: mockBook, libraryCopy: mockCopy, libraryLoan: mockLoan, $transaction: (fn: (t: unknown) => unknown) => fn(db) };
jest.mock("../../utils/academicContext", () => ({ academicDb: () => db }));

import { authMiddleware } from "../../middlewares/auth.middleware";
import { booksRouter, nextAccessionCodes } from "./books.routes";

const app = express();
app.use(express.json()); app.use("/books", authMiddleware(), booksRouter); app.use(errorHandler);
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { jest.clearAllMocks(); mockCopy.findFirst.mockResolvedValue({ accessionCode: "LIB-000010" }); });

test("nextAccessionCodes continues after the highest existing code", async () => {
  expect(await nextAccessionCodes(db as never, "school-a", 3)).toEqual(["LIB-000011", "LIB-000012", "LIB-000013"]);
  expect(mockCopy.findFirst.mock.calls[0][0].where.institutionId).toBe("school-a");
});

test("nextAccessionCodes starts at 1 for an empty library", async () => {
  mockCopy.findFirst.mockResolvedValue(null);
  expect(await nextAccessionCodes(db as never, "school-a", 2)).toEqual(["LIB-000001", "LIB-000002"]);
});

test("creating a book with 3 copies creates 3 distinct codes owned by the school", async () => {
  mockBook.create.mockResolvedValue({ id });
  const res = await request(app).post("/books").send({ title: "  Wings of Fire ", author: "A. P. J. Abdul Kalam", copies: 3 });
  expect(res.status).toBe(201);
  expect(mockBook.create.mock.calls[0][0].data).toMatchObject({ title: "Wings of Fire", institutionId: "school-a" });
  const copies = mockCopy.createMany.mock.calls[0][0].data;
  expect(copies.map((c: { accessionCode: string }) => c.accessionCode)).toEqual(["LIB-000011", "LIB-000012", "LIB-000013"]);
  expect(copies.every((c: { institutionId: string; bookId: string }) => c.institutionId === "school-a" && c.bookId === id)).toBe(true);
});

test("copy count must be between 1 and 500 and bodies cannot inject institutionId", async () => {
  for (const body of [{ title: "X", copies: 0 }, { title: "X", copies: 501 }, { title: " ", copies: 1 }, { title: "X", copies: 1, institutionId: "school-b" }]) {
    expect((await request(app).post("/books").send(body)).status).toBe(400);
  }
  expect(mockBook.create).not.toHaveBeenCalled();
});

test("duplicate accession code race returns a conflict", async () => {
  mockBook.create.mockResolvedValue({ id });
  mockCopy.createMany.mockRejectedValue({ code: "P2002" });
  expect((await request(app).post("/books").send({ title: "X", copies: 1 })).status).toBe(409);
});

test("listing is scoped to the school and reports availability counts", async () => {
  mockBook.findMany.mockResolvedValue([{ id, title: "A", copies: [{ status: "AVAILABLE" }, { status: "ISSUED" }, { status: "LOST" }] }]);
  mockBook.count.mockResolvedValue(1);
  const res = await request(app).get("/books?q=wings");
  expect(res.status).toBe(200);
  expect(res.body.data.items[0]).toMatchObject({ total: 3, available: 1 });
  expect(mockBook.findMany.mock.calls[0][0].where.institutionId).toBe("school-a");
});

test("deleting a book that has loan history is refused", async () => {
  mockBook.findFirst.mockResolvedValue({ id });
  mockLoan.count.mockResolvedValue(1);
  expect((await request(app).delete(`/books/${id}`)).status).toBe(409);
  expect(mockLoan.count.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a", copy: { bookId: id } });
  expect(mockBook.deleteMany).not.toHaveBeenCalled();
});

test("deleting an unknown book is 404", async () => {
  mockBook.findFirst.mockResolvedValue(null);
  expect((await request(app).delete(`/books/${id}`)).status).toBe(404);
});

test("a copy cannot be set to ISSUED by hand", async () => {
  expect((await request(app).patch(`/books/copies/${id}/status`).send({ status: "ISSUED" })).status).toBe(400);
});

test("a copy that is currently issued cannot change status", async () => {
  mockCopy.findFirst.mockResolvedValue({ id, status: "ISSUED" });
  expect((await request(app).patch(`/books/copies/${id}/status`).send({ status: "LOST" })).status).toBe(409);
  expect(mockCopy.updateMany).not.toHaveBeenCalled();
});

test("a lost copy that is found can be restored to AVAILABLE", async () => {
  mockCopy.findFirst.mockResolvedValue({ id, status: "LOST" });
  mockCopy.updateMany.mockResolvedValue({ count: 1 });
  expect((await request(app).patch(`/books/copies/${id}/status`).send({ status: "AVAILABLE" })).status).toBe(200);
  expect(mockCopy.updateMany.mock.calls[0][0].where).toMatchObject({ id, institutionId: "school-a" });
});

test("lists a book's copies with their codes and status, scoped to the school", async () => {
  mockBook.findFirst.mockResolvedValue({ id, title: "Wings of Fire" });
  mockCopy.findMany.mockResolvedValue([{ id: "c1", accessionCode: "LIB-000001", status: "AVAILABLE" }]);
  const res = await request(app).get(`/books/${id}/copies`);
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ title: "Wings of Fire", copies: [{ id: "c1", accessionCode: "LIB-000001", status: "AVAILABLE" }] });
  expect(mockBook.findFirst.mock.calls[0][0].where).toEqual({ id, institutionId: "school-a" });
  expect(mockCopy.findMany.mock.calls[0][0].where).toEqual({ bookId: id, institutionId: "school-a" });
});

test("copies of an unknown book is 404", async () => {
  mockBook.findFirst.mockResolvedValue(null);
  expect((await request(app).get(`/books/${id}/copies`)).status).toBe(404);
  expect(mockCopy.findMany).not.toHaveBeenCalled();
});

test("labels for a code range are scoped to the school and carry the book title", async () => {
  mockCopy.findMany.mockResolvedValue([{ accessionCode: "LIB-000001", book: { title: "Wings of Fire" } }, { accessionCode: "LIB-000002", book: { title: "Gitanjali" } }]);
  const res = await request(app).get("/books/labels?from=lib-000001&to=LIB-000002");
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ labels: [{ code: "LIB-000001", title: "Wings of Fire" }, { code: "LIB-000002", title: "Gitanjali" }], truncated: false });
  expect(mockCopy.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", accessionCode: { gte: "LIB-000001", lte: "LIB-000002" } });
});

test("a label range over 2000 copies is cut off and flagged", async () => {
  mockCopy.findMany.mockResolvedValue(Array.from({ length: 2001 }, (_, i) => ({ accessionCode: `LIB-${String(i + 1).padStart(6, "0")}`, book: { title: "B" } })));
  const res = await request(app).get("/books/labels?from=LIB-000001&to=LIB-009999");
  expect(res.body.data.labels).toHaveLength(2000);
  expect(res.body.data.truncated).toBe(true);
  expect(mockCopy.findMany.mock.calls[0][0].take).toBe(2001);
});

test("a label range needs both ends", async () => {
  expect((await request(app).get("/books/labels?from=LIB-000001")).status).toBe(400);
  expect((await request(app).get("/books/labels")).status).toBe(400);
});
