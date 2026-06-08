import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { prisma } from "../../utils/prisma";
import { setPresence } from "../../services/presence.service";
import {
  upload,
  listFolders,
  createFolder,
  deleteFolder,
  uploadFile,
  deleteFile,
  aiScan,
  aiChat,
  aiQuiz,
  searchImages,
} from "./blackboard.controller";
import {
  taskUpload,
  generateQuestions,
  listQuestions,
  editQuestion,
  deleteQuestion,
  exportQuestions,
  listModules,
  createModule,
  editModule,
  deleteModule,
  assignQuestionToModule,
  unassignQuestionFromModule,
} from "./tasks.controller";

const router = Router();

const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware];

// ── Presence heartbeat ────────────────────────────────────────────────────────
router.post("/presence", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await setPresence(req.user!.userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Me ────────────────────────────────────────────────────────────────────────
router.get("/me", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    const user = await prisma.user.findFirst({
      where: { id: userId, institutionId },
      select: { id: true, name: true },
    });
    res.json({ success: true, data: { id: user?.id ?? userId, name: user?.name ?? "Teacher" } });
  } catch (err) {
    next(err);
  }
});

// ── Classes ───────────────────────────────────────────────────────────────────
router.get("/classes", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }

    const teacher = await prisma.teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    const assignments = await prisma.divisionAssignment.findMany({
      where: { teacherId: teacher.id, institutionId },
      include: {
        division: {
          include: {
            standard: true,
            _count: { select: { students: true } },
            assignments: {
              include: {
                teacher: { include: { user: { select: { id: true, name: true } } } },
                subject: true,
              },
            },
          },
        },
        subject: true,
      },
    });

    const classTeacher = assignments
      .filter((a) => a.subjectId === null)
      .map((a) => ({
        id: a.id,
        divisionId: a.divisionId,
        divisionName: a.division.name,
        standardName: a.division.standard.name,
        studentCount: a.division._count.students,
        subjects: a.division.assignments
          .filter((da) => da.subjectId !== null && da.subject !== null)
          .map((da) => ({
            id: da.subject!.id,
            name: da.subject!.name,
            color: da.subject!.color,
            teacherName: da.teacher.user.name,
          })),
      }));

    const subjectTeacher = assignments
      .filter((a) => a.subjectId !== null && a.subject !== null)
      .map((a) => ({
        id: a.id,
        divisionId: a.divisionId,
        divisionName: a.division.name,
        standardName: a.division.standard.name,
        subjectId: a.subject!.id,
        subjectName: a.subject!.name,
        subjectColor: a.subject!.color,
        studentCount: a.division._count.students,
      }));

    res.json({ success: true, data: { classTeacher, subjectTeacher } });
  } catch (err) {
    next(err);
  }
});

// ── Class Detail ─────────────────────────────────────────────────────────────
router.get("/classes/:divisionId", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }
    const divisionId = req.params.divisionId as string;

    const teacher = await prisma.teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    // Security gate — teacher must be assigned to this division
    const hasAssignment = await prisma.divisionAssignment.findFirst({
      where: { divisionId, teacherId: teacher.id, institutionId },
      select: { id: true },
    });
    if (!hasAssignment) {
      res.status(403).json({ success: false, error: "You are not assigned to this division" });
      return;
    }

    const division = await prisma.division.findFirst({
      where: { id: divisionId, institutionId },
      include: {
        standard: {
          include: { subjects: { orderBy: { order: "asc" } } },
        },
        divisionSubjects: { select: { subjectId: true } },
        assignments: {
          include: {
            teacher: { include: { user: { select: { id: true, name: true } } } },
            subject: true,
          },
        },
        _count: { select: { students: true } },
      },
    });
    if (!division) {
      res.status(404).json({ success: false, error: "Division not found" });
      return;
    }

    res.json({ success: true, data: division });
  } catch (err) {
    next(err);
  }
});

// ── Blackboard Storage ────────────────────────────────────────────────────────
router.get("/blackboard/storage/folders", ...T, listFolders);
router.post("/blackboard/storage/folders", ...T, createFolder);
router.delete("/blackboard/storage/folders/:id", ...T, deleteFolder);
router.post("/blackboard/storage/folders/:id/files", ...T, upload.single("file"), uploadFile);
router.delete("/blackboard/storage/files/:id", ...T, deleteFile);

// ── Blackboard AI ─────────────────────────────────────────────────────────────
router.post("/blackboard/ai/scan", ...T, aiScan);
router.post("/blackboard/ai/chat", ...T, aiChat);
router.post("/blackboard/ai/quiz", ...T, aiQuiz);

// ── Blackboard Images ─────────────────────────────────────────────────────────
router.get("/blackboard/images", ...T, searchImages);

// ── Tasks — Question Generation ───────────────────────────────────────────────
router.post("/tasks/generate", ...T, taskUpload.single("file"), generateQuestions);
router.get("/tasks/questions", ...T, listQuestions);
router.patch("/tasks/questions/:id", ...T, editQuestion);
router.delete("/tasks/questions/:id", ...T, deleteQuestion);
router.get("/tasks/questions/export", ...T, exportQuestions);

// ── Tasks — Modules ───────────────────────────────────────────────────────────
router.get("/tasks/modules", ...T, listModules);
router.post("/tasks/modules", ...T, createModule);
router.patch("/tasks/modules/:id", ...T, editModule);
router.delete("/tasks/modules/:id", ...T, deleteModule);

// ── Tasks — Module-Question Assignment ────────────────────────────────────────
router.post("/tasks/modules/:id/questions", ...T, assignQuestionToModule);
router.delete("/tasks/modules/:id/questions/:qid", ...T, unassignQuestionFromModule);

export default router;
