import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "u1", institutionId: "school-a", role: "ADMIN" }; next();
} }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));

const mockBook = { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() };
const mockCopy = { findFirst: jest.fn(), createMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() };
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
