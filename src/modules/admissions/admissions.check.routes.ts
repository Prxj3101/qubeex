import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { academicDb } from "../../utils/academicContext";
import { BadRequestError } from "../../utils/errors";
import { sectionLabel } from "./admissions.shared";

/**
 * "Is this child already coming through Admissions?" - used by the teacher's
 * Add student form so the same child is not added twice. Read only; returns
 * only what the warning needs (no parent contact details).
 */
const router = Router();
router.use(authMiddleware(["TEACHER", "ADMIN", "SUB_ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

router.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const institutionId = req.user?.institutionId;
    if (!institutionId) throw new BadRequestError("No institution associated with this account");
    const q = z.object({
      name: z.string().trim().min(2).max(100),
      dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
    }).parse(req.query);
    const db = academicDb();
    const rows = await db.admissionApplication.findMany({
      where: {
        institutionId,
        childName: { equals: q.name.trim(), mode: "insensitive" },
        ...(q.dob ? { dob: q.dob } : {}),
        OR: [{ outcome: null }, { outcome: "WAITLIST" }],
      },
      select: { childName: true, applicationNo: true, stage: true, admissionNo: true, studentId: true, standardId: true, divisionId: true, dob: true },
      take: 5,
    });
    const matches = rows.filter(r => norm(r.childName) === norm(q.name));
    const standards = matches.length
      ? await db.standard.findMany({ where: { institutionId, id: { in: [...new Set(matches.map(m => m.standardId))] } }, select: { id: true, name: true, divisions: { select: { id: true, name: true } } } })
      : [];
    res.json({ success: true, data: matches.map(m => {
      const std = standards.find(s => s.id === m.standardId);
      const div = std?.divisions.find(d => d.id === m.divisionId);
      return {
        childName: m.childName, applicationNo: m.applicationNo, stage: m.stage, admissionNo: m.admissionNo, dob: m.dob,
        placed: !!m.studentId, className: std?.name ?? "", section: std && div ? sectionLabel(std.name, div.name) : null,
      };
    }) });
  } catch (err) { next(err); }
});

export default router;
