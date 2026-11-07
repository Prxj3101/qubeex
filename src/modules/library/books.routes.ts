import { Router, Response, NextFunction } from "express";
import type { PrismaClient } from "../../generated/prisma/client";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { ConflictError, NotFoundError } from "../../utils/errors";
import {
  addCopiesSchema, copyStatusSchema, createBookSchema, idSchema, pageSchema, updateBookSchema,
} from "./library.schema";
import { institutionOf, auditLibrary } from "./library.common";

type CopyDb = Pick<PrismaClient, "libraryCopy">;

const CODE_PREFIX = "LIB-";

export async function nextAccessionCodes(db: CopyDb, institutionId: string, count: number): Promise<string[]> {
  const last = await db.libraryCopy.findFirst({
    where: { institutionId, accessionCode: { startsWith: CODE_PREFIX } },
    orderBy: { accessionCode: "desc" },
    select: { accessionCode: true },
  });
  const lastNumber = last ? parseInt(last.accessionCode.slice(CODE_PREFIX.length), 10) || 0 : 0;
  return Array.from({ length: count }, (_, i) => `${CODE_PREFIX}${String(lastNumber + i + 1).padStart(6, "0")}`);
}

const conflictOnDuplicate = (err: unknown, next: NextFunction) => {
  if ((err as { code?: string })?.code === "P2002") return next(new ConflictError("A copy with this code already exists. Please try again."));
  next(err);
};

export const booksRouter = Router();

booksRouter.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const { page, pageSize } = pageSchema.parse(req.query);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    const where = {
      institutionId,
      ...(category ? { category } : {}),
      ...(q ? { OR: [
        { title: { contains: q, mode: "insensitive" as const } },
        { author: { contains: q, mode: "insensitive" as const } },
        { isbn: { contains: q, mode: "insensitive" as const } },
      ] } : {}),
    };
    const [books, total] = await Promise.all([
      academicDb().libraryBook.findMany({
        where, orderBy: { title: "asc" }, skip: (page - 1) * pageSize, take: pageSize,
        include: { copies: { select: { status: true } } },
      }),
      academicDb().libraryBook.count({ where }),
    ]);
    const items = books.map(({ copies, ...book }) => ({
      ...book,
      total: copies.length,
      available: copies.filter((c) => c.status === "AVAILABLE").length,
    }));
    res.json({ success: true, data: { items, total, page, pageSize } });
  } catch (err) { next(err); }
});

booksRouter.post("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const { copies, ...fields } = createBookSchema.parse(req.body);
    const book = await academicDb().$transaction(async (tx) => {
      const created = await tx.libraryBook.create({ data: { ...fields, institutionId } });
      const codes = await nextAccessionCodes(tx, institutionId, copies);
      await tx.libraryCopy.createMany({
        data: codes.map((accessionCode) => ({ institutionId, bookId: created.id, accessionCode })),
      });
      return created;
    });
    auditLibrary(req, "LIBRARY_BOOK_CREATED", `Added "${fields.title}" with ${copies} copies`, { bookId: book.id, copies });
    res.status(201).json({ success: true, data: book });
  } catch (err) { conflictOnDuplicate(err, next); }
});

booksRouter.patch("/copies/:copyId/status", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const copyId = idSchema.parse(req.params.copyId);
    const { status } = copyStatusSchema.parse(req.body);
    const copy = await academicDb().libraryCopy.findFirst({ where: { id: copyId, institutionId } });
    if (!copy) throw new NotFoundError("Copy not found");
    if (copy.status === "ISSUED") throw new ConflictError("This copy is issued. Return it first (choose lost or damaged on return).");
    await academicDb().libraryCopy.updateMany({ where: { id: copyId, institutionId, status: { not: "ISSUED" } }, data: { status } });
    auditLibrary(req, "LIBRARY_COPY_STATUS", `Copy status set to ${status}`, { copyId, status });
    res.json({ success: true });
  } catch (err) { next(err); }
});

booksRouter.patch("/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const id = idSchema.parse(req.params.id);
    const data = updateBookSchema.parse(req.body);
    const result = await academicDb().libraryBook.updateMany({ where: { id, institutionId }, data });
    if (!result.count) throw new NotFoundError("Book not found");
    res.json({ success: true, data: await academicDb().libraryBook.findFirst({ where: { id, institutionId } }) });
  } catch (err) { next(err); }
});

booksRouter.delete("/:id", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const id = idSchema.parse(req.params.id);
    const book = await academicDb().libraryBook.findFirst({ where: { id, institutionId }, select: { id: true } });
    if (!book) throw new NotFoundError("Book not found");
    const loans = await academicDb().libraryLoan.count({ where: { institutionId, copy: { bookId: id } } });
    if (loans > 0) throw new ConflictError("This book has been issued before and cannot be deleted. Mark its copies withdrawn instead.");
    await academicDb().$transaction(async (tx) => {
      await tx.libraryCopy.deleteMany({ where: { bookId: id, institutionId } });
      await tx.libraryBook.deleteMany({ where: { id, institutionId } });
    });
    auditLibrary(req, "LIBRARY_BOOK_DELETED", "Book deleted", { bookId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

booksRouter.post("/:id/copies", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const id = idSchema.parse(req.params.id);
    const { count } = addCopiesSchema.parse(req.body);
    const book = await academicDb().libraryBook.findFirst({ where: { id, institutionId }, select: { id: true } });
    if (!book) throw new NotFoundError("Book not found");
    const codes = await academicDb().$transaction(async (tx) => {
      const generated = await nextAccessionCodes(tx, institutionId, count);
      await tx.libraryCopy.createMany({ data: generated.map((accessionCode) => ({ institutionId, bookId: id, accessionCode })) });
      return generated;
    });
    auditLibrary(req, "LIBRARY_COPIES_ADDED", `Added ${count} copies`, { bookId: id, count });
    res.status(201).json({ success: true, data: { accessionCodes: codes } });
  } catch (err) { conflictOnDuplicate(err, next); }
});
