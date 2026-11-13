import express from "express";
import request from "supertest";
import { errorHandler } from "../../middlewares/errorHandler.middleware";
import { ConflictError } from "../../utils/errors";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "lib1", institutionId: "school-a", role: "SUB_ADMIN" }; next();
} }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));
jest.mock("./settings.routes", () => ({ loadActiveRules: jest.fn() }));

const mockUser = { findFirst: jest.fn() };
jest.mock("../../utils/prisma", () => ({ prisma: { user: mockUser } }));
const mockStudent = { findFirst: jest.fn() };
const mockTeacher = { findFirst: jest.fn() };
const mockCopy = { findFirst: jest.fn(), updateMany: jest.fn() };
const mockLoan = { count: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() };
const mockFine = { create: jest.fn(async ({ data }: any) => ({ id: "f1", ...data })) };
const db = { student: mockStudent, teacher: mockTeacher, libraryCopy: mockCopy, libraryLoan: mockLoan, libraryFine: mockFine, $transaction: (fn: (t: unknown) => unknown) => fn(db) };
jest.mock("../../utils/academicContext", () => ({ academicDb: () => db }));

import { authMiddleware } from "../../middlewares/auth.middleware";
import { loadActiveRules } from "./settings.routes";
import { logAudit } from "../../services/audit.service";
import { circulationRouter } from "./circulation.routes";

const DAY = 864e5;
const rule = { maxBooks: 2, loanDays: 14, maxRenewals: 1, finePerDayPaise: 200, graceDays: 0, fineCapPaise: null };
const rules = { STUDENT: rule, TEACHER: { ...rule, maxBooks: 5 }, STAFF: rule };
const settings = { finesMode: "LIBRARIAN", lostChargePaise: 40000, damagedChargePaise: 5000, rulesConfigured: true };
const student = { id: "stu1", name: "Asha", role: "STUDENT", isActive: true, displayId: "S001" };
const copy = { id: "copy1", institutionId: "school-a", accessionCode: "LIB-000001", status: "AVAILABLE", book: { title: "Wings of Fire" } };

const app = express();
app.use(express.json()); app.use("/c", authMiddleware(), circulationRouter); app.use(errorHandler);
beforeEach(() => {
  jest.clearAllMocks();
  (loadActiveRules as jest.Mock).mockResolvedValue({ settings, rules });
  mockUser.findFirst.mockResolvedValue(student);
  mockCopy.findFirst.mockResolvedValue(copy);
  mockCopy.updateMany.mockResolvedValue({ count: 1 });
  mockLoan.count.mockResolvedValue(0);
  mockLoan.create.mockImplementation(async ({ data }: any) => ({ id: "loan1", ...data }));
});

describe("issue", () => {
  test("creates a loan due loanDays after issue and marks the copy ISSUED", async () => {
    const res = await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "LIB-000001" });
    expect(res.status).toBe(201);
    const data = mockLoan.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ institutionId: "school-a", copyId: "copy1", borrowerUserId: "stu1", borrowerType: "STUDENT", issuedById: "lib1" });
    expect(data.dueAt.getTime() - data.issuedAt.getTime()).toBe(14 * DAY);
    expect(mockCopy.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "copy1", institutionId: "school-a", status: "AVAILABLE" }, data: { status: "ISSUED" } });
    expect(logAudit).toHaveBeenCalledWith("LIBRARY_ISSUE", expect.anything());
  });

  test("codes with stray whitespace and lower case still resolve", async () => {
    const res = await request(app).post("/c/issue").send({ memberCode: "  s001\n", copyCode: " lib-000001 " });
    expect(res.status).toBe(201);
    expect(mockCopy.findFirst.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a", accessionCode: "LIB-000001" });
  });

  test("a copy that is already issued, lost, damaged or withdrawn is refused", async () => {
    for (const status of ["ISSUED", "LOST", "DAMAGED", "WITHDRAWN"]) {
      mockCopy.findFirst.mockResolvedValue({ ...copy, status });
      const res = await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "LIB-000001" });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(status.toLowerCase());
    }
    expect(mockLoan.create).not.toHaveBeenCalled();
  });

  test("a member at the maximum books is refused", async () => {
    mockLoan.count.mockResolvedValue(2);
    expect((await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "LIB-000001" })).status).toBe(409);
    expect(mockLoan.count.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a", borrowerUserId: "stu1", returnedAt: null });
    expect(mockLoan.create).not.toHaveBeenCalled();
  });

  test("a teacher uses the teacher limit", async () => {
    mockUser.findFirst.mockResolvedValue({ ...student, role: "TEACHER" });
    mockLoan.count.mockResolvedValue(4);
    expect((await request(app).post("/c/issue").send({ memberCode: "T1", copyCode: "LIB-000001" })).status).toBe(201);
  });

  test("rules not set up blocks issuing", async () => {
    (loadActiveRules as jest.Mock).mockRejectedValue(new ConflictError("Library rules are not set up yet"));
    const res = await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "LIB-000001" });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("Library rules are not set up yet");
  });

  test("losing the race for a copy creates no loan", async () => {
    mockCopy.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "LIB-000001" })).status).toBe(409);
    expect(mockLoan.create).not.toHaveBeenCalled();
  });

  test("an unknown member is 404 and an unknown copy is 404", async () => {
    mockUser.findFirst.mockResolvedValue(null); mockStudent.findFirst.mockResolvedValue(null); mockTeacher.findFirst.mockResolvedValue(null);
    expect((await request(app).post("/c/issue").send({ memberCode: "NOPE", copyCode: "LIB-000001" })).status).toBe(404);
    mockUser.findFirst.mockResolvedValue(student); mockCopy.findFirst.mockResolvedValue(null);
    expect((await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "NOPE" })).status).toBe(404);
  });

  test("a deactivated member cannot borrow", async () => {
    mockUser.findFirst.mockResolvedValue({ ...student, isActive: false });
    expect((await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "LIB-000001" })).status).toBe(409);
    expect(mockLoan.create).not.toHaveBeenCalled();
  });

  test("a member is found through their student ID when no display ID matches", async () => {
    mockUser.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(student);
    mockStudent.findFirst.mockResolvedValue({ userId: "stu1" });
    expect((await request(app).post("/c/issue").send({ memberCode: "2024-17", copyCode: "LIB-000001" })).status).toBe(201);
    expect(mockStudent.findFirst.mock.calls[0][0].where.institutionId).toBe("school-a");
  });

  test("bodies cannot inject institutionId", async () => {
    expect((await request(app).post("/c/issue").send({ memberCode: "S001", copyCode: "X", institutionId: "school-b" })).status).toBe(400);
  });
});

describe("return", () => {
  const openLoan = { id: "loan1", institutionId: "school-a", copyId: "copy1", borrowerUserId: "stu1", borrowerType: "STUDENT", dueAt: new Date(Date.now() - 3 * DAY), renewals: 0 };
  beforeEach(() => {
    mockCopy.findFirst.mockResolvedValue({ ...copy, status: "ISSUED" });
    mockLoan.findFirst.mockResolvedValue(openLoan);
    mockLoan.updateMany.mockResolvedValue({ count: 1 });
  });

  test("closes the loan, frees the copy and reports the late fine", async () => {
    const res = await request(app).post("/c/return").send({ copyCode: "lib-000001" });
    expect(res.status).toBe(200);
    expect(mockLoan.findFirst.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a", copyId: "copy1", returnedAt: null });
    expect(mockLoan.updateMany.mock.calls[0][0].data).toMatchObject({ returnedById: "lib1" });
    expect(mockCopy.updateMany.mock.calls[0][0].data).toEqual({ status: "AVAILABLE" });
    expect(res.body.data.fines).toHaveLength(1);
    expect(res.body.data.fines[0]).toMatchObject({ kind: "LATE", amountPaise: 600 });
  });

  test("the result says who had the book", async () => {
    const res = await request(app).post("/c/return").send({ copyCode: "LIB-000001" });
    expect(res.body.data.borrower).toEqual({ name: "Asha", code: "S001" });
    expect(mockUser.findFirst.mock.calls.at(-1)?.[0].where).toMatchObject({ id: "stu1", institutionId: "school-a" });
  });

  test("returning a copy that is not issued is 404 and changes nothing", async () => {
    mockLoan.findFirst.mockResolvedValue(null);
    expect((await request(app).post("/c/return").send({ copyCode: "LIB-000001" })).status).toBe(404);
    expect(mockLoan.updateMany).not.toHaveBeenCalled();
  });

  test("declaring the book lost marks the copy LOST and charges the lost fee", async () => {
    const res = await request(app).post("/c/return").send({ copyCode: "LIB-000001", condition: "LOST" });
    expect(res.status).toBe(200);
    expect(mockCopy.updateMany.mock.calls[0][0].data).toEqual({ status: "LOST" });
    expect(res.body.data.fines.map((f: { kind: string }) => f.kind)).toContain("LOST");
  });

  test("an invalid condition is rejected", async () => {
    expect((await request(app).post("/c/return").send({ copyCode: "LIB-000001", condition: "MELTED" })).status).toBe(400);
  });

  test("an unknown copy code is 404", async () => {
    mockCopy.findFirst.mockResolvedValue(null);
    expect((await request(app).post("/c/return").send({ copyCode: "NOPE" })).status).toBe(404);
  });
});

describe("renew", () => {
  const dueIn5Days = new Date(Date.now() + 5 * DAY);
  const openLoan = { id: "loan1", institutionId: "school-a", copyId: "copy1", borrowerUserId: "stu1", borrowerType: "STUDENT", dueAt: dueIn5Days, renewals: 0 };
  beforeEach(() => {
    mockCopy.findFirst.mockResolvedValue({ ...copy, status: "ISSUED" });
    mockLoan.findFirst.mockResolvedValue(openLoan);
    mockLoan.updateMany.mockResolvedValue({ count: 1 });
  });

  test("an overdue loan cannot be renewed, so its accrued fine is not wiped", async () => {
    mockLoan.findFirst.mockResolvedValue({ ...openLoan, dueAt: new Date(Date.now() - 2 * DAY) });
    const res = await request(app).post("/c/renew").send({ copyCode: "LIB-000001" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/overdue/i);
    expect(mockLoan.updateMany).not.toHaveBeenCalled();
  });

  test("extends the due date by loanDays from the current due date", async () => {
    const res = await request(app).post("/c/renew").send({ copyCode: "LIB-000001" });
    expect(res.status).toBe(200);
    const update = mockLoan.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ id: "loan1", institutionId: "school-a", returnedAt: null, renewals: 0 });
    expect(update.data.dueAt.toISOString()).toBe(new Date(dueIn5Days.getTime() + 14 * DAY).toISOString());
    expect(update.data.renewals).toBe(1);
  });

  test("is refused once renewals are used up", async () => {
    mockLoan.findFirst.mockResolvedValue({ ...openLoan, renewals: 1 });
    expect((await request(app).post("/c/renew").send({ copyCode: "LIB-000001" })).status).toBe(409);
    expect(mockLoan.updateMany).not.toHaveBeenCalled();
  });

  test("a concurrent renewal that wins first is a conflict", async () => {
    mockLoan.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post("/c/renew").send({ copyCode: "LIB-000001" })).status).toBe(409);
  });
});

describe("member lookup", () => {
  test("returns the member with their open loans, scoped to the school", async () => {
    mockLoan.count.mockResolvedValue(1);
    mockLoan.findMany.mockResolvedValue([{ id: "loan1", dueAt: new Date(), copy: { accessionCode: "LIB-000001", book: { title: "Wings of Fire" } } }]);
    const res = await request(app).get("/c/members/s001");
    expect(res.status).toBe(200);
    expect(res.body.data.member).toMatchObject({ userId: "stu1", borrowerType: "STUDENT", code: "S001" });
    expect(res.body.data.loans).toHaveLength(1);
    expect(mockLoan.findMany.mock.calls[0][0].where).toMatchObject({ institutionId: "school-a", borrowerUserId: "stu1", returnedAt: null });
  });

  test("unknown code is 404", async () => {
    mockUser.findFirst.mockResolvedValue(null); mockStudent.findFirst.mockResolvedValue(null); mockTeacher.findFirst.mockResolvedValue(null);
    expect((await request(app).get("/c/members/NOPE")).status).toBe(404);
  });
});
