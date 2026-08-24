// src/modules/admin/notepad.controller.ts
import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import {
  createNoteSchema,
  updateNoteSchema,
  createTaskSchema,
  updateTaskSchema,
} from "./notepad.schema";

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

    const [notes, tasks] = await Promise.all([
      academicDb().adminNote.findMany({
        where: { userId, institutionId },
        orderBy: { createdAt: "desc" },
      }),
      academicDb().adminTask.findMany({
        where: { userId, institutionId },
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
    const { text, color } = createNoteSchema.parse(req.body);

    const note = await academicDb().adminNote.create({
      data: { userId, institutionId, text, color },
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
    const { text } = updateNoteSchema.parse(req.body);
    const id = req.params.id as string;

    const existing = await academicDb().adminNote.findFirst({ where: { id, userId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Note not found" });
      return;
    }

    const note = await academicDb().adminNote.update({ where: { id }, data: { text } });
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
    const id = req.params.id as string;

    const existing = await academicDb().adminNote.findFirst({ where: { id, userId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Note not found" });
      return;
    }

    await academicDb().adminNote.delete({ where: { id } });
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
    const { text } = createTaskSchema.parse(req.body);

    const task = await academicDb().adminTask.create({
      data: { userId, institutionId, text },
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
    const data = updateTaskSchema.parse(req.body);
    const id = req.params.id as string;

    const existing = await academicDb().adminTask.findFirst({ where: { id, userId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Task not found" });
      return;
    }

    const task = await academicDb().adminTask.update({ where: { id }, data });
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
    const id = req.params.id as string;

    const existing = await academicDb().adminTask.findFirst({ where: { id, userId, institutionId } });
    if (!existing) {
      res.status(404).json({ success: false, error: "Task not found" });
      return;
    }

    await academicDb().adminTask.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    handleError(err, res, next);
  }
}
