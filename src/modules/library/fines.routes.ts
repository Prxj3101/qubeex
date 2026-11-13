import { Router, Response, NextFunction } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { prisma } from "../../utils/prisma";
import { ConflictError, NotFoundError } from "../../utils/errors";
import { fineListSchema, idSchema, waiveSchema } from "./library.schema";
import { actorIdOf, auditLibrary, institutionOf } from "./library.common";

export const finesRouter = Router();

finesRouter.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const { status, userId, page, pageSize } = fineListSchema.parse(req.query);
    const where = { institutionId, ...(status ? { status } : {}), ...(userId ? { borrowerUserId: userId } : {}) };
    const [items, total] = await Promise.all([
      academicDb().libraryFine.findMany({
        where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize,
        include: { loan: { select: { copy: { select: { accessionCode: true, book: { select: { title: true } } } } } } },
      }),
      academicDb().libraryFine.count({ where }),
    ]);
    const ids = [...new Set(items.map((f) => f.borrowerUserId))];
    const users = ids.length
      ? await prisma.user.findMany({ where: { institutionId, id: { in: ids } }, select: { id: true, name: true, displayId: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const withMembers = items.map((f) => ({
      ...f,
      member: { name: byId.get(f.borrowerUserId)?.name ?? "Unknown", code: byId.get(f.borrowerUserId)?.displayId ?? null },
    }));
    res.json({ success: true, data: { items: withMembers, total, page, pageSize } });
  } catch (err) { next(err); }
});

// Marking paid works for both modes: in "added to fees" mode the librarian/admin
// records it here once the fees desk has received the money.
finesRouter.post("/:id/collect", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const actorId = actorIdOf(req);
    const id = idSchema.parse(req.params.id);
    const fine = await academicDb().libraryFine.findFirst({ where: { id, institutionId } });
    if (!fine) throw new NotFoundError("Fine not found");
    if (fine.status !== "PENDING") throw new ConflictError(`This fine is already ${fine.status.toLowerCase()}`);
    const changed = await academicDb().libraryFine.updateMany({
      where: { id, institutionId, status: "PENDING" },
      data: { status: "PAID", paidAt: new Date(), collectedById: actorId },
    });
    if (changed.count === 0) throw new ConflictError("This fine was just updated. Please refresh.");
    auditLibrary(req, "LIBRARY_FINE_COLLECTED", "Library fine marked paid", { fineId: id, collectedVia: fine.collectedVia });
    res.json({ success: true });
  } catch (err) { next(err); }
});

finesRouter.post("/:id/waive", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = institutionOf(req);
    const actorId = actorIdOf(req);
    const id = idSchema.parse(req.params.id);
    const { reason } = waiveSchema.parse(req.body);
    const fine = await academicDb().libraryFine.findFirst({ where: { id, institutionId } });
    if (!fine) throw new NotFoundError("Fine not found");
    if (fine.status !== "PENDING") throw new ConflictError(`This fine is already ${fine.status.toLowerCase()}`);
    const changed = await academicDb().libraryFine.updateMany({
      where: { id, institutionId, status: "PENDING" },
      data: { status: "WAIVED", waivedReason: reason, collectedById: actorId },
    });
    if (changed.count === 0) throw new ConflictError("This fine was just updated. Please refresh.");
    auditLibrary(req, "LIBRARY_FINE_WAIVED", "Library fine waived", { fineId: id, reason });
    res.json({ success: true });
  } catch (err) { next(err); }
});
