import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl } from "../../services/storage.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { createFolderSchema, aiScanSchema, aiChatSchema, aiQuizSchema } from "./blackboard.schema";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const ALLOWED_MIMETYPES = new Set([
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function requireTeacher(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

async function getTeacherId(userId: string, institutionId: string): Promise<string> {
  const teacher = await prisma.teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
  if (!teacher) throw new BadRequestError("Teacher profile not found");
  return teacher.id;
}

// ── Storage: Folders ──────────────────────────────────────────────────────────

export const listFolders = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);

    const [folders, files] = await Promise.all([
      prisma.blackboardFolder.findMany({
        where: { teacherId, institutionId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, parentId: true, createdAt: true },
      }),
      prisma.blackboardMaterial.findMany({
        where: { teacherId, institutionId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, fileUrl: true, mimeType: true, size: true, folderId: true, createdAt: true },
      }),
    ]);

    // Build tree in-memory
    type FolderNode = {
      id: string; name: string; parentId: string | null; createdAt: Date;
      children: FolderNode[];
      files: typeof files;
    };
    const map = new Map<string, FolderNode>();
    for (const f of folders) map.set(f.id, { ...f, children: [], files: [] });
    for (const file of files) {
      const folder = map.get(file.folderId);
      if (folder) folder.files.push(file);
    }
    const roots: FolderNode[] = [];
    for (const f of map.values()) {
      if (!f.parentId) { roots.push(f); }
      else { map.get(f.parentId)?.children.push(f); }
    }

    res.json({ success: true, data: roots });
  } catch (err) { next(err); }
};

export const createFolder = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const data = createFolderSchema.parse(req.body);

    if (data.parentId) {
      const parent = await prisma.blackboardFolder.findFirst({
        where: { id: data.parentId, teacherId, institutionId },
      });
      if (!parent) throw new NotFoundError("Parent folder not found");
    }

    const folder = await prisma.blackboardFolder.create({
      data: { institutionId, teacherId, name: data.name, parentId: data.parentId ?? null },
      select: { id: true, name: true, parentId: true, createdAt: true },
    });

    res.status(201).json({ success: true, data: { ...folder, children: [], files: [] } });
  } catch (err) { next(err); }
};

export const deleteFolder = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const folderId = req.params.id as string;

    const folder = await prisma.blackboardFolder.findFirst({ where: { id: folderId, teacherId, institutionId } });
    if (!folder) throw new NotFoundError("Folder not found");

    // Collect all descendant folder IDs (BFS)
    const allFolderIds: string[] = [folderId];
    const queue = [folderId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await prisma.blackboardFolder.findMany({
        where: { parentId: current, teacherId, institutionId },
        select: { id: true },
      });
      for (const c of children) { allFolderIds.push(c.id); queue.push(c.id); }
    }

    // Collect all r2Keys for files in these folders
    const files = await prisma.blackboardMaterial.findMany({
      where: { folderId: { in: allFolderIds }, institutionId },
      select: { r2Key: true },
    });

    // Delete folders (deepest first to avoid FK issues — children cascade deletes files)
    for (let i = allFolderIds.length - 1; i >= 0; i--) {
      await prisma.blackboardFolder.delete({ where: { id: allFolderIds[i] } });
    }

    // Schedule R2 deletions
    for (const f of files) {
      await scheduleR2FileDeletion(f.r2Key).catch((e) => console.error("[blackboard deleteFolder] Failed to schedule R2 deletion:", e));
    }

    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── Storage: Files ────────────────────────────────────────────────────────────

export const uploadFile = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const folderId = req.params.id as string;

    const folder = await prisma.blackboardFolder.findFirst({ where: { id: folderId, teacherId, institutionId } });
    if (!folder) throw new NotFoundError("Folder not found");

    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");
    if (!ALLOWED_MIMETYPES.has(file.mimetype)) {
      throw new BadRequestError("File type not allowed. Accepted: PDF, PPT, PPTX, DOC, DOCX");
    }

    const result = await uploadAttachmentToR2(file.buffer, {
      originalName: file.originalname,
      contentType: file.mimetype,
      institutionId,
      area: "blackboard",
    });

    const r2Key = r2KeyFromUrl(result.publicUrl);
    if (!r2Key) throw new BadRequestError("R2 key extraction failed — check R2_PUBLIC_URL configuration");

    const material = await prisma.blackboardMaterial.create({
      data: {
        institutionId,
        teacherId,
        folderId,
        name: file.originalname,
        fileUrl: result.publicUrl,
        r2Key,
        mimeType: file.mimetype,
        size: file.size,
      },
      select: { id: true, name: true, fileUrl: true, mimeType: true, size: true, folderId: true, createdAt: true },
    });

    res.status(201).json({ success: true, data: material });
  } catch (err) { next(err); }
};

export const deleteFile = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireTeacher(req);
    const teacherId = await getTeacherId(userId, institutionId);
    const fileId = req.params.id as string;

    const file = await prisma.blackboardMaterial.findFirst({ where: { id: fileId, teacherId, institutionId } });
    if (!file) throw new NotFoundError("File not found");

    await prisma.blackboardMaterial.delete({ where: { id: fileId } });
    await scheduleR2FileDeletion(file.r2Key).catch(() => {});

    res.json({ success: true });
  } catch (err) { next(err); }
};

