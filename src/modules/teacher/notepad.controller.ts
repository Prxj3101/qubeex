// src/modules/teacher/notepad.controller.ts
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import {
  createNoteSchema,
  updateNoteSchema,
  createTaskSchema,
  updateTaskSchema,
} from "./notepad.schema";

async function getTeacherId(userId: string, institutionId: string): Promise<string> {
  const teacher = await academicDb().teacher.findFirst({
    where: { userId, institutionId },
    select: { id: true },
  });
  if (!teacher) throw { status: 404, message: "Teacher profile not found" };
  return teacher.id;
}

function handleError(err: unknown, res: Response, next: NextFunction) {
  const e = err as { status?: number; message?: string };
  if (e.status) {
    res.status(e.status).json({ success: false, error: e.message });
    return;
  }
  next(err);
}

export async function getNotepad(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const teacherId = await getTeacherId(userId, institutionId);

    const [notes, tasks] = await Promise.all([
      academicDb().teacherNote.findMany({
        where: { teacherId, institutionId },
        orderBy: { createdAt: "desc" },
      }),
      academicDb().teacherTask.findMany({
        where: { teacherId, institutionId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    res.json({ success: true, data: { notes, tasks } });
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function createNote(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const teacherId = await getTeacherId(userId, institutionId);
    const { text, color } = createNoteSchema.parse(req.body);

    const note = await academicDb().teacherNote.create({
      data: { teacherId, institutionId, text, color },
    });
    res.status(201).json({ success: true, data: note });
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function updateNote(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const teacherId = await getTeacherId(userId, institutionId);
    const { text } = updateNoteSchema.parse(req.body);
    const id = req.params.id as string;

    const existing = await academicDb().teacherNote.findFirst({ where: { id, teacherId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Note not found" });
      return;
    }

    const note = await academicDb().teacherNote.update({ where: { id }, data: { text } });
    res.json({ success: true, data: note });
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function deleteNote(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const existing = await academicDb().teacherNote.findFirst({ where: { id, teacherId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Note not found" });
      return;
    }

    await academicDb().teacherNote.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function createTask(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const teacherId = await getTeacherId(userId, institutionId);
    const { text } = createTaskSchema.parse(req.body);

    const task = await academicDb().teacherTask.create({
      data: { teacherId, institutionId, text },
    });
    res.status(201).json({ success: true, data: task });
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function updateTask(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const teacherId = await getTeacherId(userId, institutionId);
    const data = updateTaskSchema.parse(req.body);
    const id = req.params.id as string;

    const existing = await academicDb().teacherTask.findFirst({ where: { id, teacherId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Task not found" });
      return;
    }

    const task = await academicDb().teacherTask.update({ where: { id }, data });
    res.json({ success: true, data: task });
  } catch (err) {
    handleError(err, res, next);
  }
}

export async function deleteTask(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const teacherId = await getTeacherId(userId, institutionId);
    const id = req.params.id as string;

    const existing = await academicDb().teacherTask.findFirst({ where: { id, teacherId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Task not found" });
      return;
    }

    await academicDb().teacherTask.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    handleError(err, res, next);
  }
}
