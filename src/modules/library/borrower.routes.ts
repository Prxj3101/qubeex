import { Router, Response, NextFunction } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { pageSchema } from "./library.schema";
import { actorIdOf, institutionOf } from "./library.common";

// Read-only views for borrowers. Everything is keyed to the caller's own userId from the token.
export function borrowerRouter(options: { withDues: boolean }): Router {
  const router = Router();

  router.get("/books", async (req: AuthRequest, res: Response, next: NextFunction) => {
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
          { category: { contains: q, mode: "insensitive" as const } },
        ] } : {}),
      };
      const [books, total] = await Promise.all([
        academicDb().libraryBook.findMany({
          where, orderBy: { title: "asc" }, skip: (page - 1) * pageSize, take: pageSize,
          include: { copies: { select: { status: true } } },
        }),
        academicDb().libraryBook.count({ where }),
      ]);
      const items = books.map((b) => ({
        id: b.id, title: b.title, author: b.author, category: b.category, shelf: b.shelf, language: b.language,
        total: b.copies.length, available: b.copies.filter((c) => c.status === "AVAILABLE").length,
      }));
      res.json({ success: true, data: { items, total, page, pageSize } });
    } catch (err) { next(err); }
  });

  router.get("/my-loans", async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const institutionId = institutionOf(req);
      const userId = actorIdOf(req);
      const [loans, fines] = await Promise.all([
        academicDb().libraryLoan.findMany({
          where: { institutionId, borrowerUserId: userId, returnedAt: null }, orderBy: { dueAt: "asc" },
          include: { copy: { select: { book: { select: { title: true } } } } },
        }),
        academicDb().libraryFine.findMany({
          where: { institutionId, borrowerUserId: userId, status: "PENDING" }, orderBy: { createdAt: "desc" },
          select: { id: true, kind: true, amountPaise: true, collectedVia: true, createdAt: true },
        }),
      ]);
      const now = Date.now();
      res.json({ success: true, data: {
        loans: loans.map((l) => ({ id: l.id, title: l.copy.book.title, issuedAt: l.issuedAt, dueAt: l.dueAt, renewals: l.renewals, overdue: l.dueAt.getTime() < now })),
        fines,
      } });
    } catch (err) { next(err); }
  });

  if (options.withDues) {
    router.get("/dues", async (req: AuthRequest, res: Response, next: NextFunction) => {
      try {
        const institutionId = institutionOf(req);
        const userId = actorIdOf(req);
        const items = await academicDb().libraryFine.findMany({
          where: { institutionId, borrowerUserId: userId, collectedVia: "FEES", status: "PENDING" },
          orderBy: { createdAt: "desc" }, select: { id: true, kind: true, amountPaise: true, createdAt: true },
        });
        res.json({ success: true, data: { items, totalPaise: items.reduce((sum, f) => sum + f.amountPaise, 0) } });
      } catch (err) { next(err); }
    });
  }

  return router;
}
