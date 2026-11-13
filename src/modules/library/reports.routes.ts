import { Router, Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { NotFoundError } from "../../utils/errors";
import { dateRangeSchema, reportPageSchema } from "./library.schema";
import { institutionOf } from "./library.common";
import { resolveMember } from "./members";

type Cell = string | number | null;
type Row = Record<string, Cell>;
type Report = { columns: string[]; rows: Row[]; total?: number; summary?: Record<string, number>; extra?: Record<string, unknown> };

const CSV_MAX_ROWS = 5000;
const DAY_MS = 864e5;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export function toCsv(columns: string[], rows: Row[]): string {
  const cell = (v: Cell): string => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // Spreadsheet apps run cells starting with these characters as formulas.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

function send(res: Response, name: string, format: "json" | "csv", report: Report) {
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="library-${name}.csv"`);
    return void res.send(toCsv(report.columns, report.rows));
  }
  res.json({ success: true, data: report });
}

// CSV exports ignore paging so the librarian gets the whole list (capped).
const paging = (req: Request) => {
  const q = reportPageSchema.parse(req.query);
  return q.format === "csv" ? { ...q, page: 1, pageSize: CSV_MAX_ROWS } : q;
};

async function memberNames(institutionId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map<string, { name: string | null; displayId: string | null; isActive: boolean }>();
  const users = await prisma.user.findMany({
    where: { institutionId, id: { in: unique } }, select: { id: true, name: true, displayId: true, isActive: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

const loanInclude = { copy: { select: { accessionCode: true, book: { select: { title: true } } } } } as const;

export const reportsRouter = Router();
const route = (path: string, build: (req: AuthRequest, institutionId: string, p: ReturnType<typeof paging>) => Promise<Report>) =>
  reportsRouter.get(path, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const institutionId = institutionOf(req);
      const p = paging(req);
      send(res, path.split("/")[1], p.format, await build(req, institutionId, p));
    } catch (err) { next(err); }
  });

route("/overdue", async (_req, institutionId, p) => {
  const now = new Date();
  const where = { institutionId, returnedAt: null, dueAt: { lt: now } };
  const [loans, total] = await Promise.all([
    academicDb().libraryLoan.findMany({ where, orderBy: { dueAt: "asc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize, include: loanInclude }),
    academicDb().libraryLoan.count({ where }),
  ]);
  const names = await memberNames(institutionId, loans.map((l) => l.borrowerUserId));
  return {
    columns: ["member", "memberCode", "book", "accessionCode", "issuedAt", "dueAt", "daysOverdue"],
    total,
    rows: loans.map((l) => ({
      member: names.get(l.borrowerUserId)?.name ?? "Unknown", memberCode: names.get(l.borrowerUserId)?.displayId ?? null,
      book: l.copy.book.title, accessionCode: l.copy.accessionCode,
      issuedAt: day(l.issuedAt), dueAt: day(l.dueAt), daysOverdue: Math.max(0, Math.floor((now.getTime() - l.dueAt.getTime()) / DAY_MS)),
    })),
  };
});

route("/most-issued", async (req, institutionId, p) => {
  const { from, to } = dateRangeSchema.parse(req.query);
  const issuedAt = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: new Date(to.getTime() + DAY_MS - 1) } : {}) } : undefined;
  const grouped = await academicDb().libraryLoan.groupBy({ by: ["copyId"], where: { institutionId, ...(issuedAt ? { issuedAt } : {}) }, _count: { _all: true } });
  const copies = grouped.length
    ? await academicDb().libraryCopy.findMany({ where: { institutionId, id: { in: grouped.map((g) => g.copyId) } }, select: { id: true, bookId: true } })
    : [];
  const bookOf = new Map(copies.map((c) => [c.id, c.bookId]));
  const perBook = new Map<string, number>();
  for (const g of grouped) {
    const bookId = bookOf.get(g.copyId);
    if (bookId) perBook.set(bookId, (perBook.get(bookId) ?? 0) + g._count._all);
  }
  const ranked = [...perBook.entries()].sort((a, b) => b[1] - a[1]).slice(0, p.pageSize);
  const books = ranked.length
    ? await academicDb().libraryBook.findMany({ where: { institutionId, id: { in: ranked.map(([id]) => id) } }, select: { id: true, title: true } })
    : [];
  const title = new Map(books.map((b) => [b.id, b.title]));
  return { columns: ["book", "issues"], total: perBook.size, rows: ranked.map(([id, issues]) => ({ book: title.get(id) ?? "Unknown", issues })) };
});

route("/never-issued", async (_req, institutionId, p) => {
  const where = { institutionId, copies: { none: { loans: { some: {} } } } };
  const [books, total] = await Promise.all([
    academicDb().libraryBook.findMany({ where, orderBy: { title: "asc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize, include: { copies: { select: { id: true } } } }),
    academicDb().libraryBook.count({ where }),
  ]);
  return { columns: ["title", "author", "category", "copies"], total, rows: books.map((b) => ({ title: b.title, author: b.author, category: b.category, copies: b.copies.length })) };
});

route("/stock", async (_req, institutionId) => {
  const grouped = await academicDb().libraryCopy.groupBy({ by: ["status"], where: { institutionId }, _count: { _all: true } });
  const summary = { total: 0, available: 0, issued: 0, lost: 0, damaged: 0, withdrawn: 0 };
  for (const g of grouped) {
    summary.total += g._count._all;
    const key = g.status.toLowerCase() as keyof typeof summary;
    if (key in summary) summary[key] += g._count._all;
  }
  return { columns: ["status", "count"], summary, rows: Object.entries(summary).map(([status, count]) => ({ status, count })) };
});

route("/fines", async (_req, institutionId) => {
  const grouped = await academicDb().libraryFine.groupBy({ by: ["status"], where: { institutionId }, _count: { _all: true }, _sum: { amountPaise: true } });
  return { columns: ["status", "count", "amountPaise"], rows: grouped.map((g) => ({ status: g.status, count: g._count._all, amountPaise: g._sum.amountPaise ?? 0 })) };
});

route("/member/:code", async (req, institutionId, p) => {
  const member = await resolveMember(institutionId, String(req.params.code));
  if (!member) throw new NotFoundError("Member not found");
  const where = { institutionId, borrowerUserId: member.userId };
  const [loans, total] = await Promise.all([
    academicDb().libraryLoan.findMany({ where, orderBy: { issuedAt: "desc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize, include: loanInclude }),
    academicDb().libraryLoan.count({ where }),
  ]);
  return {
    columns: ["book", "accessionCode", "issuedAt", "dueAt", "returnedAt"], total, extra: { member },
    rows: loans.map((l) => ({ book: l.copy.book.title, accessionCode: l.copy.accessionCode, issuedAt: day(l.issuedAt), dueAt: day(l.dueAt), returnedAt: day(l.returnedAt) })),
  };
});
