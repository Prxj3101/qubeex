import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { BadRequestError } from "../../utils/errors";
import { logAudit } from "../../services/audit.service";
import {
  listContactsForStudent,
  getMessagesForStudent,
  sendMessageFromStudent,
  markReadForStudent,
  unreadCountForStudent,
  listThreadsForTeacher,
  getMessagesForTeacher,
  sendMessageFromTeacher,
  markReadForTeacher,
  unreadCountForTeacher,
  listThreadsForAdmin,
  getThreadForAdmin,
  hideMessage,
  getChatSettings,
  saveChatSettings,
} from "../../services/parentChat.service";
import { sendMessageSchema, messagesQuerySchema, chatSettingsSchema, idParamSchema } from "./parentChat.schema";

function ctx(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: AuthRequest, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

// ── Student (Parent Mode) — mounted at /api/student/parent-chat ──────────────

const S = [authMiddleware(["STUDENT"]), institutionAccessMiddleware, academicRoutingMiddleware];
export const studentParentChatRoutes = Router();

studentParentChatRoutes.get("/contacts", ...S, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: await listContactsForStudent(userId, institutionId) });
}));

studentParentChatRoutes.get("/unread-count", ...S, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: { unread: await unreadCountForStudent(userId, institutionId) } });
}));

studentParentChatRoutes.get("/teachers/:id/messages", ...S, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  const q = messagesQuerySchema.parse(req.query);
  res.json({ success: true, data: await getMessagesForStudent(userId, institutionId, id, q) });
}));

studentParentChatRoutes.post("/teachers/:id/messages", ...S, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  const { text } = sendMessageSchema.parse(req.body);
  res.status(201).json({ success: true, data: await sendMessageFromStudent(userId, institutionId, id, text) });
}));

studentParentChatRoutes.patch("/teachers/:id/read", ...S, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  await markReadForStudent(userId, institutionId, id);
  res.json({ success: true });
}));

// ── Teacher — mounted at /api/teacher/parent-chat ────────────────────────────

const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware, academicRoutingMiddleware];
export const teacherParentChatRoutes = Router();

teacherParentChatRoutes.get("/threads", ...T, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: await listThreadsForTeacher(userId, institutionId) });
}));

teacherParentChatRoutes.get("/unread-count", ...T, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  res.json({ success: true, data: { unread: await unreadCountForTeacher(userId, institutionId) } });
}));

teacherParentChatRoutes.get("/threads/:id/messages", ...T, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  const q = messagesQuerySchema.parse(req.query);
  res.json({ success: true, data: await getMessagesForTeacher(userId, institutionId, id, q) });
}));

teacherParentChatRoutes.post("/threads/:id/messages", ...T, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  const { text } = sendMessageSchema.parse(req.body);
  res.status(201).json({ success: true, data: await sendMessageFromTeacher(userId, institutionId, id, text) });
}));

teacherParentChatRoutes.patch("/threads/:id/read", ...T, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  await markReadForTeacher(userId, institutionId, id);
  res.json({ success: true });
}));

// ── Admin — mounted at /api/admin/parent-chat (ADMIN only: private conversations) ─

const A = [authMiddleware(["ADMIN"]), institutionAccessMiddleware, academicRoutingMiddleware];
export const adminParentChatRoutes = Router();

adminParentChatRoutes.get("/settings", ...A, wrap(async (req, res) => {
  const { institutionId } = ctx(req);
  res.json({ success: true, data: await getChatSettings(institutionId) });
}));

adminParentChatRoutes.put("/settings", ...A, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const input = chatSettingsSchema.parse(req.body);
  const saved = await saveChatSettings(institutionId, input);
  logAudit("PARENT_CHAT_SETTINGS_UPDATED", { userId, actorRole: "ADMIN", institutionId, details: JSON.stringify(saved), ip: req.ip });
  res.json({ success: true, data: saved });
}));

adminParentChatRoutes.get("/threads", ...A, wrap(async (req, res) => {
  const { institutionId } = ctx(req);
  res.json({ success: true, data: await listThreadsForAdmin(institutionId) });
}));

adminParentChatRoutes.get("/threads/:id", ...A, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  const thread = await getThreadForAdmin(institutionId, id);
  logAudit("PARENT_CHAT_THREAD_VIEWED", { userId, actorRole: "ADMIN", institutionId, details: `thread ${id}`, ip: req.ip });
  res.json({ success: true, data: thread });
}));

adminParentChatRoutes.patch("/messages/:id/hide", ...A, wrap(async (req, res) => {
  const { institutionId, userId } = ctx(req);
  const { id } = idParamSchema.parse(req.params);
  await hideMessage(institutionId, id, userId);
  logAudit("PARENT_CHAT_MESSAGE_HIDDEN", { userId, actorRole: "ADMIN", institutionId, details: `message ${id}`, ip: req.ip });
  res.json({ success: true });
}));
