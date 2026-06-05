import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
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

const router = Router();

const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware];

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

export default router;
