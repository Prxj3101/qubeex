import { AsyncResource } from "node:async_hooks";
import { RequestHandler } from "express";
import { BadRequestError } from "../../utils/errors";
const multer = require("multer") as typeof import("multer");

const documents = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "text/plain",
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 15 * 1024 * 1024, fields: 1, fieldSize: 16 * 1024, parts: 6 },
  fileFilter: (_req, file, cb) => { if (!documents.has(file.mimetype)) return cb(new BadRequestError("Attach a photo, PDF, Word, Excel, PowerPoint or text document")); cb(null, true); },
}).array("files", 5);

export const receiptUpload: RequestHandler = (req, res, next) => {
  // Multipart stream events may run outside the request AsyncLocalStorage scope.
  upload(req, res, AsyncResource.bind((err: unknown) => {
    if (err) return next(err instanceof multer.MulterError ? new BadRequestError(err.code === "LIMIT_FILE_SIZE" ? "Each document must be 15 MB or smaller" : "Attach up to 5 documents with the receipt") : err);
    const files = (req.files || []) as Express.Multer.File[];
    if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) return next(new BadRequestError("Attachments must total 25 MB or less"));
    for (const file of files) {
      const limit = file.mimetype.startsWith("image/") ? 5 : file.mimetype === "application/pdf" ? 10 : 15;
      if (!file.size || file.size > limit * 1024 * 1024) return next(new BadRequestError(`${file.originalname} must be non-empty and ${limit} MB or smaller`));
    }
    next();
  }));
};
