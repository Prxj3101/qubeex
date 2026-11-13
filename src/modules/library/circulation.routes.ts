import { Router, Response, NextFunction } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { ConflictError, NotFoundError } from "../../utils/errors";
import { issueSchema, renewSchema, returnSchema } from "./library.schema";
import { actorIdOf, auditLibrary, institutionOf } from "./library.common";
import { computeDueAt, isOverdue, normaliseCode } from "./library.rules";
import { prisma } from "../../utils/prisma";
import { resolveMember } from "./members";
import { loadActiveRules } from "./settings.routes";
import { createFinesForReturn } from "./fines.service";

export const circulationRouter = Router();

circulationRouter.get("/members/:code", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const member = await resolveMember(institutionId, String(req.params.code));
    if (!member) throw new NotFoundError("Member not found");
    const loans = await academicDb().libraryLoan.findMany({
      where: { institutionId, borrowerUserId: member.userId, returnedAt: null },
      orderBy: { dueAt: "asc" },
      include: { copy: { select: { accessionCode: true, book: { select: { title: true } } } } },
    });
    res.json({ success: true, data: { member, loans } });
  } catch (err) { next(err); }
});

circulationRouter.post("/issue", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const actorId = actorIdOf(req);
    const { memberCode, copyCode } = issueSchema.parse(req.body);
    const { rules } = await loadActiveRules(institutionId);
    const member = await resolveMember(institutionId, memberCode);
    if (!member) throw new NotFoundError("Member not found");
    if (!member.isActive) throw new ConflictError("This member's account is deactivated and cannot borrow books");
    const rule = rules[member.borrowerType];

    const loan = await academicDb().$transaction(async (tx) => {
      const copy = await tx.libraryCopy.findFirst({
        where: { institutionId, accessionCode: normaliseCode(copyCode) },
        include: { book: { select: { title: true } } },
      });
      if (!copy) throw new NotFoundError("Book copy not found");
      if (copy.status !== "AVAILABLE") throw new ConflictError(`This copy is ${copy.status.toLowerCase()} and cannot be issued`);

      const open = await tx.libraryLoan.count({ where: { institutionId, borrowerUserId: member.userId, returnedAt: null } });
      if (open >= rule.maxBooks) throw new ConflictError(`${member.name} already has ${open} book${open === 1 ? "" : "s"} (limit ${rule.maxBooks})`);

      // Guarded update: only one concurrent issue can flip AVAILABLE to ISSUED.
      const claimed = await tx.libraryCopy.updateMany({
        where: { id: copy.id, institutionId, status: "AVAILABLE" }, data: { status: "ISSUED" },
      });
      if (claimed.count === 0) throw new ConflictError("This copy was just issued to someone else");

      const issuedAt = new Date();
      return tx.libraryLoan.create({
        data: {
          institutionId, copyId: copy.id, borrowerUserId: member.userId, borrowerType: member.borrowerType,
          issuedAt, dueAt: computeDueAt(issuedAt, rule.loanDays), issuedById: actorId,
        },
      });
    });
    auditLibrary(req, "LIBRARY_ISSUE", `Issued ${normaliseCode(copyCode)} to ${member.name}`, { loanId: loan.id, borrowerUserId: member.userId });
    res.status(201).json({ success: true, data: loan });
  } catch (err) { next(err); }
});

circulationRouter.post("/return", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const actorId = actorIdOf(req);
    const { copyCode, condition } = returnSchema.parse(req.body);
    const { settings, rules } = await loadActiveRules(institutionId);

    const result = await academicDb().$transaction(async (tx) => {
      const copy = await tx.libraryCopy.findFirst({ where: { institutionId, accessionCode: normaliseCode(copyCode) } });
      if (!copy) throw new NotFoundError("Book copy not found");
      const loan = await tx.libraryLoan.findFirst({ where: { institutionId, copyId: copy.id, returnedAt: null } });
      if (!loan) throw new NotFoundError("This copy is not currently issued");

      const returnedAt = new Date();
      const closed = await tx.libraryLoan.updateMany({
        where: { id: loan.id, institutionId, returnedAt: null }, data: { returnedAt, returnedById: actorId },
      });
      if (closed.count === 0) throw new ConflictError("This loan was already closed");
      await tx.libraryCopy.updateMany({
        where: { id: copy.id, institutionId },
        data: { status: condition === "OK" ? "AVAILABLE" : condition },
      });
      const borrowerType = loan.borrowerType as "STUDENT" | "TEACHER" | "STAFF";
      const fines = await createFinesForReturn(tx, {
        institutionId, loan, condition, returnedAt, borrowerType, settings, rule: rules[borrowerType],
      });
      return { loan: { ...loan, returnedAt, returnedById: actorId }, fines };
    });
    const borrower = await prisma.user.findFirst({
      where: { id: result.loan.borrowerUserId, institutionId }, select: { name: true, displayId: true },
    });
    auditLibrary(req, "LIBRARY_RETURN", `Returned ${normaliseCode(copyCode)} (${condition})`, { loanId: result.loan.id, fines: result.fines.length });
    res.json({ success: true, data: { ...result, borrower: { name: borrower?.name ?? "Unknown", code: borrower?.displayId ?? null } } });
  } catch (err) { next(err); }
});

circulationRouter.post("/renew", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const { copyCode } = renewSchema.parse(req.body);
    const { rules } = await loadActiveRules(institutionId);

    const updated = await academicDb().$transaction(async (tx) => {
      const copy = await tx.libraryCopy.findFirst({ where: { institutionId, accessionCode: normaliseCode(copyCode) } });
      if (!copy) throw new NotFoundError("Book copy not found");
      const loan = await tx.libraryLoan.findFirst({ where: { institutionId, copyId: copy.id, returnedAt: null } });
      if (!loan) throw new NotFoundError("This copy is not currently issued");
      const rule = rules[loan.borrowerType as "STUDENT" | "TEACHER" | "STAFF"];
      if (isOverdue(loan.dueAt, new Date())) throw new ConflictError("This book is overdue. Return it first so the late fine is recorded.");
      if (loan.renewals >= rule.maxRenewals) throw new ConflictError(`Renewal limit reached (${rule.maxRenewals})`);

      const dueAt = computeDueAt(loan.dueAt, rule.loanDays);
      const changed = await tx.libraryLoan.updateMany({
        where: { id: loan.id, institutionId, returnedAt: null, renewals: loan.renewals },
        data: { dueAt, renewals: loan.renewals + 1 },
      });
      if (changed.count === 0) throw new ConflictError("This loan was just changed. Please try again.");
      return { ...loan, dueAt, renewals: loan.renewals + 1 };
    });
    auditLibrary(req, "LIBRARY_RENEW", `Renewed ${normaliseCode(copyCode)}`, { loanId: updated.id });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});
