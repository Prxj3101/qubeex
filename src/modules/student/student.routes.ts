import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { prisma } from "../../utils/prisma";
import { z } from "zod";

const router = Router();

const S = [authMiddleware(["STUDENT"]), institutionAccessMiddleware];

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  phone: z.string().max(20).trim().optional().nullable(),
  religion: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  bloodGroup: z.string().trim().optional().nullable(),
  aadharNo: z.string().trim().optional().nullable(),
  panNo: z.string().trim().optional().nullable(),
  emergencyContact: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state: z.string().trim().optional().nullable(),
  pincode: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  guardians: z
    .array(z.object({ name: z.string(), number: z.string(), relation: z.string() }))
    .optional()
    .nullable(),
});

// ── GET /student/me ───────────────────────────────────────────────────────────
router.get("/me", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      include: {
        user: {
          select: { id: true, name: true, email: true, mustChangePassword: true },
        },
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });

    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    res.json({ success: true, data: student });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /student/profile ────────────────────────────────────────────────────
// Students can edit personal info but NOT academic details (rollNo, houseColor, standardId, divisionId, studentId, status)
router.patch("/profile", ...S, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const student = await prisma.student.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });

    if (!student) {
      res.status(404).json({ success: false, error: "Student profile not found" });
      return;
    }

    const data = updateProfileSchema.parse(req.body);
    const { name, guardians, ...studentFields } = data;

    await prisma.$transaction(async (tx) => {
      if (name) {
        await tx.user.update({ where: { id: userId }, data: { name } });
      }
      await tx.student.update({
        where: { id: student.id },
        data: {
          ...studentFields,
          ...(guardians !== undefined
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? { guardians: guardians === null ? null : (guardians as any) }
            : {}),
        },
      });
    });

    const updated = await prisma.student.findFirst({
      where: { id: student.id },
      include: {
        user: {
          select: { id: true, name: true, email: true, mustChangePassword: true },
        },
        standard: { select: { id: true, name: true } },
        division: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
