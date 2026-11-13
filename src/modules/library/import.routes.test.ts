import express from "express";
import request from "supertest";
import ExcelJS from "exceljs";
import { errorHandler } from "../../middlewares/errorHandler.middleware";

jest.mock("../../middlewares/auth.middleware", () => ({ authMiddleware: () => (req: any, _res: any, next: any) => {
  req.user = { userId: "u1", institutionId: "school-a", role: "ADMIN" }; next();
} }));
jest.mock("../../services/audit.service", () => ({ logAudit: jest.fn() }));

const mockBook = { createMany: jest.fn() };
const mockCopy = { findFirst: jest.fn(), createMany: jest.fn() };
const db = { libraryBook: mockBook, libraryCopy: mockCopy, $transaction: (fn: (t: unknown) => unknown) => fn(db) };
jest.mock("../../utils/academicContext", () => ({ academicDb: () => db }));

import { authMiddleware } from "../../middlewares/auth.middleware";
import { importRouter } from "./import.routes";

const app = express();
app.use(express.json()); app.use("/import", authMiddleware(), importRouter); app.use(errorHandler);
beforeEach(() => { jest.clearAllMocks(); mockCopy.findFirst.mockResolvedValue(null); });

const csv = (text: string) => Buffer.from(text, "utf8");
const preview = (buf: Buffer, name = "books.csv") => request(app).post("/import/preview").attach("file", buf, name);
const commit = (buf: Buffer, name = "books.csv") => request(app).post("/import/commit").attach("file", buf, name);

test("a valid file previews every row as ok", async () => {
  const res = await preview(csv("Title,Author,ISBN,Category,Price,Copies\nWings of Fire,Kalam,9788173711466,Biography,250,3\nMalgudi Days,R K Narayan,,Fiction,,\n"));
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ total: 2, valid: 2 });
  expect(res.body.data.rows[0].data).toMatchObject({ title: "Wings of Fire", pricePaise: 25000, copies: 3 });
  expect(res.body.data.rows[1].data.copies).toBe(1);
});

test("a leading-zero ISBN stays exactly as written", async () => {
  const res = await preview(csv("title,isbn\nOld Book,0140328726\n"));
  expect(res.body.data.rows[0].data.isbn).toBe("0140328726");
});

test("a missing title column is rejected", async () => {
  expect((await preview(csv("Author,ISBN\nKalam,123\n"))).status).toBe(400);
});

test("blank rows are ignored and row numbers match the sheet", async () => {
  const res = await preview(csv("title\nA\n\n,,\nB\n"));
  expect(res.body.data.total).toBe(2);
  expect(res.body.data.rows.map((r: { row: number }) => r.row)).toEqual([2, 5]);
});

test("a duplicate ISBN inside the file is flagged", async () => {
  const res = await preview(csv("title,isbn\nA,978-81-7371-146-6\nB,9788173711466\n"));
  expect(res.body.data.valid).toBe(1);
  expect(res.body.data.rows[1].errors.join(" ")).toMatch(/duplicate isbn/i);
});

test("bad copies and a missing title are reported per row", async () => {
  const res = await preview(csv("title,copies\nA,0\n,2\nB,501\nC,x\n"));
  expect(res.body.data.valid).toBe(0);
  expect(res.body.data.rows.every((r: { ok: boolean }) => !r.ok)).toBe(true);
});

test("more than 5000 rows is refused", async () => {
  const lines = ["title"]; for (let i = 0; i < 5001; i++) lines.push(`Book ${i}`);
  expect((await preview(csv(lines.join("\n")))).status).toBe(400);
});

test("wrong file types are refused by extension and by content", async () => {
  expect((await preview(Buffer.from("MZ binary"), "virus.exe")).status).toBe(400);
  expect((await preview(csv("title\nA"), "books.xlsx")).status).toBe(400); // text pretending to be xlsx
  expect((await preview(Buffer.from([0x74, 0x00, 0x69, 0x74]), "books.csv")).status).toBe(400); // NUL bytes
});

test("a real xlsx file is read", async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Books");
  ws.addRow(["Title", "Copies"]); ws.addRow(["Gitanjali", 2]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const res = await preview(buf, "books.xlsx");
  expect(res.status).toBe(200);
  expect(res.body.data.rows[0].data).toMatchObject({ title: "Gitanjali", copies: 2 });
});

test("commit with any bad row creates nothing", async () => {
  const res = await commit(csv("title,copies\nA,1\n,2\n"));
  expect(res.status).toBe(400);
  expect(mockBook.createMany).not.toHaveBeenCalled();
});

test("commit creates books and consecutive copy codes for the school", async () => {
  mockCopy.findFirst.mockResolvedValue({ accessionCode: "LIB-000005" });
  const res = await commit(csv("title,copies\nA,2\nB,1\n"));
  expect(res.status).toBe(201);
  const books = mockBook.createMany.mock.calls[0][0].data;
  const copies = mockCopy.createMany.mock.calls[0][0].data;
  expect(books).toHaveLength(2);
  expect(books.every((b: { institutionId: string }) => b.institutionId === "school-a")).toBe(true);
  expect(copies.map((c: { accessionCode: string }) => c.accessionCode)).toEqual(["LIB-000006", "LIB-000007", "LIB-000008"]);
  expect(copies[0].bookId).toBe(books[0].id);
  expect(copies[2].bookId).toBe(books[1].id);
  expect(res.body.data).toMatchObject({ books: 2, copies: 3, firstCode: "LIB-000006", lastCode: "LIB-000008" });
});
