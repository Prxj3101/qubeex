import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { uploadAttachmentToR2 } from "../../services/storage.service";
import { z } from "zod";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");

// ── Multer (memory) — ticket attachments ───────────────────────────────────────

export const ticketAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const attachmentSchema = z.object({
  url: z.string().url(),
  name: z.string().max(200),
  type: z.enum(["image", "video", "file"]),
  size: z.number().int().nonnegative(),
});

const createTicketSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().min(1).max(5000).trim(),
  category: z.enum(["BUG", "FEATURE", "BILLING", "OTHER"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  attachments: z.array(attachmentSchema).max(5).optional(),
});

const addReplySchema = z.object({
  message: z.string().min(1).max(2000).trim(),
  attachments: z.array(attachmentSchema).max(5).optional(),
});

const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().min(1).max(200).trim(),
  body: z.string().min(1).max(5000).trim(),
});

const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  title: z.string().min(1).max(200).trim().optional(),
  body: z.string().min(1).max(5000).trim().optional(),
});

// ── Helper ────────────────────────────────────────────────────────────────────

function requireInstitution(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

// ── Ticket attachment upload ───────────────────────────────────────────────────

export const uploadTicketAttachment = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId } = requireInstitution(req);

    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");

    const result = await uploadAttachmentToR2(file.buffer, {
      originalName: file.originalname,
      contentType: file.mimetype,
      institutionId,
      area: "support/tickets",
    });

    res.json({
      success: true,
      data: {
        url: result.publicUrl,
        name: file.originalname,
        type: result.attachmentType,
        size: file.size,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Tickets ───────────────────────────────────────────────────────────────────

export const listTickets = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);
    const status = req.query.status as string | undefined;

    const tickets = await prisma.supportTicket.findMany({
      where: {
        institutionId,
        ...(status && status !== "ALL" ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        replies: { orderBy: { createdAt: "asc" } },
      },
    });

    res.json({ success: true, data: tickets });
  } catch (err) {
    next(err);
  }
};

export const createTicket = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const data = createTicketSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw new NotFoundError("User not found");

    const ticket = await prisma.supportTicket.create({
      data: {
        institutionId,
        adminEmail: user.email,
        title: data.title,
        description: data.description,
        category: data.category,
        priority: data.priority,
        status: "OPEN",
        attachments: data.attachments ?? undefined,
      },
      include: { replies: true },
    });

    res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
};

export const addTicketReply = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId: _uid } = requireInstitution(req);
    const ticketId = req.params.ticketId as string;
    const data = addReplySchema.parse(req.body);

    const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, institutionId } });
    if (!ticket) throw new NotFoundError("Ticket not found");
    if (ticket.status === "CLOSED") throw new BadRequestError("Cannot reply to a closed ticket");

    const reply = await prisma.ticketReply.create({
      data: {
        ticketId,
        author: "Admin",
        role: "ADMIN",
        message: data.message,
        attachments: data.attachments ?? undefined,
      },
    });

    // Move to IN_PROGRESS if still OPEN
    if (ticket.status === "OPEN") {
      await prisma.supportTicket.update({
        where: { id: ticketId },
        data: { status: "IN_PROGRESS" },
      });
    }

    res.status(201).json({ success: true, data: reply });
  } catch (err) {
    next(err);
  }
};

// ── Reviews ───────────────────────────────────────────────────────────────────

export const listReviews = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);

    const reviews = await prisma.review.findMany({
      where: { institutionId },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: reviews });
  } catch (err) {
    next(err);
  }
};

export const createReview = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const data = createReviewSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    if (!user) throw new NotFoundError("User not found");

    const review = await prisma.review.create({
      data: {
        institutionId,
        adminName: user.name ?? "Admin",
        adminEmail: user.email,
        rating: data.rating,
        title: data.title,
        body: data.body,
      },
    });

    res.status(201).json({ success: true, data: review });
  } catch (err) {
    next(err);
  }
};

export const updateReview = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);
    const id = req.params.id as string;
    const data = updateReviewSchema.parse(req.body);

    const review = await prisma.review.findFirst({ where: { id, institutionId } });
    if (!review) throw new NotFoundError("Review not found");

    const updated = await prisma.review.update({ where: { id }, data });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};
