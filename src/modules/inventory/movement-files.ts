import { RequestHandler } from "express";
import { createHash } from "node:crypto";
import { receiptUpload } from "./receipt-upload";
import { BadRequestError, ConflictError } from "../../utils/errors";
import { uploadAttachmentToR2, scheduleR2FileDeletion } from "../../services/storage.service";
import { AuthRequest } from "../../middlewares/auth.middleware";
import type { Prisma } from "../../generated/prisma/client";
const states = new WeakMap<object, { keys: string[]; committed: boolean }>();
export const movementUpload: RequestHandler = (req, res, next) => {
 const state = { keys: [] as string[], committed: false }; states.set(req, state);
 res.on('finish', () => { if (!state.committed) for (const key of state.keys) void scheduleR2FileDeletion(key).catch(() => {}); });
 receiptUpload(req, res, err => {
  if (err) return next(err);
  if (req.is('multipart/form-data')) { try { req.body = JSON.parse(req.body?.payload); } catch { return next(new BadRequestError('Invalid entry details')); } }
  next();
 });
};
export const commitMovementFiles = (req: AuthRequest) => { const state = states.get(req); if (state) state.committed = true; };
export function fileFingerprints(req: AuthRequest) {
 return ((req.files || []) as Express.Multer.File[]).map(file => ({ name: file.originalname, type: file.mimetype, size: file.size, sha256: createHash('sha256').update(file.buffer).digest('hex') }));
}
export function checkMovementFiles(req: AuthRequest, saved: unknown) {
 const files = fileFingerprints(req);
 const existing = Array.isArray(saved) ? saved as { name: string; type: string; size: number; sha256?: string }[] : [];
 if (JSON.stringify(existing.map(({ name, type, size, sha256 }) => ({ name, type, size, sha256 }))) !== JSON.stringify(files)) throw new ConflictError('This entry was already recorded with different attachments');
}
export async function uploadMovementFiles(req: AuthRequest, institutionId: string) {
 const files = (req.files || []) as Express.Multer.File[], prints = fileFingerprints(req);
 const attachments: Prisma.JsonObject[] = [];
 for (const [index, file] of files.entries()) {
  const result = await uploadAttachmentToR2(file.buffer, { originalName: file.originalname, contentType: file.mimetype, institutionId, area: 'inventory/ledger' });
  states.get(req)?.keys.push(result.path); attachments.push({ ...prints[index], url: result.publicUrl });
 }
 return attachments;
}
