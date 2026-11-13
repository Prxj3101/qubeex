import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "lib1", institutionId: "school-a", role: "SUB_ADMIN" }; next();
} }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));
const mockUser = { findMany: jest.fn() };
jest.mock("../../utils/prisma", () => ({ prisma: { user: mockUser } }));
jest.mock("./members", () => ({ resolveMember: jest.fn() }));
const mockLoan = { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() };
const mockCopy = { groupBy: jest.fn(), findMany: jest.fn() };
const mockBook = { findMany: jest.fn(), count: jest.fn() };
const mockFine = { groupBy: jest.fn() };
jest.mock("../../utils/academicContext", () => ({ academicDb: () => ({ libraryLoan: mockLoan, libraryCopy: mockCopy, libraryBook: mockBook, libraryFine: mockFine }) }));

import { authMiddleware } from "../../middlewares/auth.middleware";
import { resolveMember } from "./members";
import { reportsRouter, toCsv } from "./reports.routes";

const app = express();
app.use(express.json()); app.use("/r", authMiddleware(), reportsRouter); app.use(errorHandler);
beforeEach(() => { jest.clearAllMocks(); mockUser.findMany.mockResolvedValue([{ id: "u1", name: "Asha, K", displayId: "S001", isActive: false }]); });

const loanRow = { id: "l1", borrowerUserId: "u1", issuedAt: new Date("2026-10-01T00:00:00Z"), dueAt: new Date("2026-10-15T00:00:00Z"), copy: { accessionCode: "LIB-000001", book: { title: 'The "Best" Book' } } };

test("overdue only looks at open loans past their due date, and includes deactivated members", async () => {
  mockLoan.findMany.mockResolvedValue([loanRow]); mockLoan.count.mockResolvedValue(1);
  const res = await request(app).get("/r/overdue");
  expect(res.status).toBe(200);
  const where = mockLoan.findMany.mock.calls[0][0].where;
  expect(where).toMatchObject({ institutionId: "school-a", returnedAt: null });
  expect(where.dueAt.lt).toBeInstanceOf(Date);
  expect(res.body.data.rows[0]).toMatchObject({ member: "Asha, K", memberCode: "S001", book: 'The "Best" Book', accessionCode: "LIB-000001" });
  expect(mockUser.findMany.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a", id: { in: ["u1"] } });
});

test("page size is clamped to 200", async () => {
  mockLoan.findMany.mockResolvedValue([]); mockLoan.count.mockResolvedValue(0);
  await request(app).get("/r/overdue?pageSize=1000");
  expect(mockLoan.findMany.mock.calls[0][0].take).toBe(200);
});

test("csv output escapes quotes and commas and neutralises spreadsheet formulas", async () => {
  mockLoan.findMany.mockResolvedValue([loanRow]); mockLoan.count.mockResolvedValue(1);
  const res = await request(app).get("/r/overdue?format=csv");
  expect(res.headers["content-type"]).toContain("text/csv");
  expect(res.text.split("\n")[0]).toContain("member");
  expect(res.text).toContain('"Asha, K"');
  expect(res.text).toContain('"The ""Best"" Book"');
  expect(toCsv(["a"], [{ a: "=SUM(A1)" }, { a: "@x" }, { a: "-1+2" }, { a: 5 }])).toBe("a\n'=SUM(A1)\n'@x\n'-1+2\n5\n");
  expect(toCsv(["a", "b"], [{ a: null, b: 1 }])).toBe("a,b\n,1\n");
});

test("stock counts add up to the total", async () => {
  mockCopy.groupBy.mockResolvedValue([{ status: "AVAILABLE", _count: { _all: 7 } }, { status: "ISSUED", _count: { _all: 2 } }, { status: "LOST", _count: { _all: 1 } }]);
  const res = await request(app).get("/r/stock");
  expect(res.body.data.summary).toEqual({ total: 10, available: 7, issued: 2, lost: 1, damaged: 0, withdrawn: 0 });
  expect(mockCopy.groupBy.mock.calls[0][0].where).toEqual({ institutionId: "school-a" });
});

test("never-issued excludes any book with a loan on any copy", async () => {
  mockBook.findMany.mockResolvedValue([{ id: "b1", title: "Dusty", author: null, category: null, copies: [{}, {}] }]); mockBook.count.mockResolvedValue(1);
  await request(app).get("/r/never-issued");
  expect(mockBook.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", copies: { none: { loans: { some: {} } } } });
});

test("most-issued ranks books by loans in the date range", async () => {
  mockLoan.groupBy.mockResolvedValue([{ copyId: "c1", _count: { _all: 3 } }, { copyId: "c2", _count: { _all: 4 } }, { copyId: "c3", _count: { _all: 1 } }]);
  mockCopy.findMany.mockResolvedValue([{ id: "c1", bookId: "b1" }, { id: "c2", bookId: "b1" }, { id: "c3", bookId: "b2" }]);
  mockBook.findMany.mockResolvedValue([{ id: "b1", title: "Popular" }, { id: "b2", title: "Quiet" }]);
  const res = await request(app).get("/r/most-issued?from=2026-10-01&to=2026-10-31");
  expect(res.body.data.rows.map((r: { book: string; issues: number }) => [r.book, r.issues])).toEqual([["Popular", 7], ["Quiet", 1]]);
  expect(mockLoan.groupBy.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a" });
  expect(mockLoan.groupBy.mock.calls[0][0].where.issuedAt.gte).toBeInstanceOf(Date);
});

test("a bad date is rejected", async () => {
  expect((await request(app).get("/r/most-issued?from=not-a-date")).status).toBe(400);
});

test("member history returns every loan, scoped to the school", async () => {
  (resolveMember as jest.Mock).mockResolvedValue({ userId: "u1", name: "Asha", code: "S001", borrowerType: "STUDENT", isActive: true, activeLoans: 1 });
  mockLoan.findMany.mockResolvedValue([{ ...loanRow, returnedAt: null }]); mockLoan.count.mockResolvedValue(1);
  const res = await request(app).get("/r/member/s001");
  expect(res.status).toBe(200);
  expect(mockLoan.findMany.mock.calls[0][0].where).toEqual({ institutionId: "school-a", borrowerUserId: "u1" });
});

test("member history for an unknown code is 404", async () => {
  (resolveMember as jest.Mock).mockResolvedValue(null);
  expect((await request(app).get("/r/member/NOPE")).status).toBe(404);
});

test("fines report totals each status within the school", async () => {
  mockFine.groupBy.mockResolvedValue([{ status: "PENDING", _count: { _all: 2 }, _sum: { amountPaise: 900 } }, { status: "PAID", _count: { _all: 1 }, _sum: { amountPaise: 200 } }]);
  const res = await request(app).get("/r/fines");
  expect(res.body.data.rows).toEqual([{ status: "PENDING", count: 2, amountPaise: 900 }, { status: "PAID", count: 1, amountPaise: 200 }]);
  expect(mockFine.groupBy.mock.calls[0][0].where).toEqual({ institutionId: "school-a" });
});
