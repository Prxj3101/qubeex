import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "me", institutionId: "school-a", role: "STUDENT" }; next();
} }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));
const mockBook = { findMany: jest.fn(), count: jest.fn() };
const mockLoan = { findMany: jest.fn() };
const mockFine = { findMany: jest.fn() };
jest.mock("../../utils/academicContext", () => ({ academicDb: () => ({ libraryBook: mockBook, libraryLoan: mockLoan, libraryFine: mockFine }) }));

import { authMiddleware } from "../../middlewares/auth.middleware";
import { borrowerRouter } from "./borrower.routes";

const student = express(); student.use("/l", authMiddleware(), borrowerRouter({ withDues: true })); student.use(errorHandler);
const teacher = express(); teacher.use("/l", authMiddleware(), borrowerRouter({ withDues: false })); teacher.use(errorHandler);
beforeEach(() => jest.clearAllMocks());

test("search is scoped to the school and never reveals accession codes", async () => {
  mockBook.findMany.mockResolvedValue([{ id: "b1", title: "Wings of Fire", author: "Kalam", category: "Bio", shelf: "A2", language: "English", copies: [{ status: "AVAILABLE" }, { status: "ISSUED" }] }]);
  mockBook.count.mockResolvedValue(1);
  const res = await request(student).get("/l/books?q=wings");
  expect(res.status).toBe(200);
  expect(res.body.data.items[0]).toEqual({ id: "b1", title: "Wings of Fire", author: "Kalam", category: "Bio", shelf: "A2", language: "English", total: 2, available: 1 });
  expect(mockBook.findMany.mock.calls[0][0].where.institutionId).toBe("school-a");
  expect(mockBook.findMany.mock.calls[0][0].include.copies.select).toEqual({ status: true });
  expect(JSON.stringify(res.body)).not.toMatch(/accession/i);
});

test("my-loans only ever shows the caller's own open loans, whatever the query says", async () => {
  mockLoan.findMany.mockResolvedValue([{ id: "l1", dueAt: new Date("2000-01-01"), renewals: 0, copy: { book: { title: "Old" } } }]);
  mockFine.findMany.mockResolvedValue([]);
  const res = await request(student).get("/l/my-loans?userId=someone-else");
  expect(res.status).toBe(200);
  expect(mockLoan.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", borrowerUserId: "me", returnedAt: null });
  expect(mockFine.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", borrowerUserId: "me", status: "PENDING" });
  expect(res.body.data.loans[0]).toMatchObject({ title: "Old", overdue: true });
});

test("dues lists only this student's pending fines that were added to fees", async () => {
  mockFine.findMany.mockResolvedValue([{ id: "f1", kind: "LATE", amountPaise: 600 }, { id: "f2", kind: "LOST", amountPaise: 40000 }]);
  const res = await request(student).get("/l/dues");
  expect(res.status).toBe(200);
  expect(mockFine.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", borrowerUserId: "me", collectedVia: "FEES", status: "PENDING" });
  expect(res.body.data.totalPaise).toBe(40600);
});

test("teachers have no dues endpoint", async () => {
  expect((await request(teacher).get("/l/dues")).status).toBe(404);
  expect(mockFine.findMany).not.toHaveBeenCalled();
});
