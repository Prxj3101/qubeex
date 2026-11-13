import { Router, Response, NextFunction } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import path from "path";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError } from "../../utils/errors";
import { institutionOf, auditLibrary } from "./library.common";
import { nextAccessionCodes } from "./books.routes";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_TOTAL_COPIES = 20000;
const CHUNK = 1000;

export type ImportBook = {
  title: string; author?: string; isbn?: string; category?: string; language?: string; shelf?: string;
  pricePaise?: number; copies: number;
};
export type PreviewRow = { row: number; ok: boolean; errors: string[]; data?: ImportBook };
export type ImportPreview = { rows: PreviewRow[]; total: number; valid: number };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } }).single("file");
const withUpload = (req: AuthRequest, res: Response, next: NextFunction) =>
  upload(req, res, (err: unknown) => {
    if (err) {
      const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
      return next(new BadRequestError(tooBig ? "File is larger than 5 MB" : "Invalid upload"));
    }
    next();
  });

async function readGrid(file: Express.Multer.File): Promise<string[][]> {
  const ext = path.extname(file.originalname).toLowerCase();
  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet | undefined;
  try {
    if (ext === ".xlsx") {
      if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b) throw new BadRequestError("This is not a valid .xlsx file");
      await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
      ws = wb.worksheets[0];
    } else if (ext === ".csv") {
      if (file.buffer.subarray(0, 1024).includes(0)) throw new BadRequestError("This is not a valid .csv file");
      // Identity map keeps every cell as written, so ISBNs with leading zeros survive.
      ws = await wb.csv.read(Readable.from(file.buffer), { map: (value: unknown) => value });
    } else {
      throw new BadRequestError("Upload a .csv or .xlsx file");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError("Could not read this file");
  }
  if (!ws) throw new BadRequestError("The file has no data");
  const grid: string[][] = [];
  const cols = ws.columnCount;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    grid.push(Array.from({ length: cols }, (_, c) => row.getCell(c + 1).text.trim()));
  }
  return grid;
}

const normIsbn = (v: string) => v.replace(/[-\s]/g, "").toUpperCase();

export async function parseBooksFile(file: Express.Multer.File | undefined): Promise<ImportPreview> {
  if (!file) throw new BadRequestError("Attach a file in the 'file' field");
  const grid = await readGrid(file);
  const header = (grid[0] ?? []).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  if (col("title") === -1) throw new BadRequestError("Missing required column: title");

  const rows: PreviewRow[] = [];
  const seenIsbn = new Set<string>();
  let totalCopies = 0;
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells.every((c) => c === "")) continue;
    const get = (name: string) => (col(name) === -1 ? "" : cells[col(name)] ?? "");
    const errors: string[] = [];
    const title = get("title");
    if (!title) errors.push("Title is required");
    const copiesText = get("copies");
    let copies = 1;
    if (copiesText !== "") {
      const n = Number(copiesText);
      if (!/^\d+$/.test(copiesText) || n < 1 || n > 500) errors.push("Copies must be a whole number from 1 to 500");
      else copies = n;
    }
    let pricePaise: number | undefined;
    const priceText = get("price").replace(/,/g, "");
    if (priceText !== "") {
      const n = Number(priceText);
      if (!Number.isFinite(n) || n < 0) errors.push("Price must be a number");
      else pricePaise = Math.round(n * 100);
    }
    const isbn = get("isbn");
    if (isbn) {
      const key = normIsbn(isbn);
      if (seenIsbn.has(key)) errors.push("Duplicate ISBN in this file");
      seenIsbn.add(key);
    }
    totalCopies += copies;
    const opt = (v: string) => (v === "" ? undefined : v);
    rows.push(errors.length
      ? { row: i + 1, ok: false, errors }
      : { row: i + 1, ok: true, errors, data: {
          title, copies, author: opt(get("author")), isbn: opt(isbn), category: opt(get("category")),
          language: opt(get("language")), shelf: opt(get("shelf")), pricePaise,
        } });
  }
  if (rows.length > MAX_ROWS) throw new BadRequestError(`A file can have at most ${MAX_ROWS} books`);
  if (totalCopies > MAX_TOTAL_COPIES) throw new BadRequestError(`A file can create at most ${MAX_TOTAL_COPIES} copies`);
  return { rows, total: rows.length, valid: rows.filter((r) => r.ok).length };
}

export const importRouter = Router();

importRouter.post("/preview", withUpload, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    institutionOf(req);
    res.json({ success: true, data: await parseBooksFile(req.file) });
  } catch (err) { next(err); }
});

importRouter.post("/commit", withUpload, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const preview = await parseBooksFile(req.file);
    if (preview.total === 0) throw new BadRequestError("The file has no books");
    if (preview.valid !== preview.total) {
      return void res.status(400).json({ success: false, error: "Fix the highlighted rows and upload again", data: preview });
    }
    const books = preview.rows.map((r) => {
      const { copies: _copies, ...fields } = r.data as ImportBook;
      return { id: randomUUID(), institutionId, ...fields };
    });
    const copyCounts = preview.rows.map((r) => (r.data as ImportBook).copies);
    const totalCopies = copyCounts.reduce((a, b) => a + b, 0);

    let firstCode = "";
    let lastCode = "";
    await academicDb().$transaction(async (tx) => {
      const codes = await nextAccessionCodes(tx, institutionId, totalCopies);
      firstCode = codes[0];
      lastCode = codes[codes.length - 1];
      for (let i = 0; i < books.length; i += CHUNK) await tx.libraryBook.createMany({ data: books.slice(i, i + CHUNK) });
      const copyData: { institutionId: string; bookId: string; accessionCode: string }[] = [];
      let cursor = 0;
      books.forEach((b, idx) => {
        for (let n = 0; n < copyCounts[idx]; n++) copyData.push({ institutionId, bookId: b.id, accessionCode: codes[cursor++] });
      });
      for (let i = 0; i < copyData.length; i += CHUNK) await tx.libraryCopy.createMany({ data: copyData.slice(i, i + CHUNK) });
    }, { timeout: 60_000 });

    auditLibrary(req, "LIBRARY_IMPORT", `Imported ${preview.total} books (${totalCopies} copies)`, { books: preview.total, copies: totalCopies });
    res.status(201).json({ success: true, data: { books: preview.total, copies: totalCopies, firstCode, lastCode } });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return next(new BadRequestError("Copy codes collided with another import. Please try again."));
    next(err);
  }
});
