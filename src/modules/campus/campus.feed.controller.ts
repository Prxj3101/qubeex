import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { z } from "zod";
import { logAudit } from "../../services/audit.service";

// ── Schemas ───────────────────────────────────────────────────────────────────

const createPostSchema = z.object({
  type: z.enum(["ANNOUNCEMENT", "NOTICE", "MATERIAL", "RESULT"]),
  title: z.string().min(1).max(300).trim(),
  body: z.string().max(5000).trim().optional().default(""),
  subject: z.string().max(100).trim().optional(),
  divisionId: z.string().uuid().optional(),
  attachmentUrl: z.string().url().optional(),
  attachmentType: z.string().max(20).optional(),
  attachmentName: z.string().max(200).optional(),
});

const createEventSchema = z.object({
  type: z.enum(["HOLIDAY", "TEST", "EXAM", "SUBMISSION", "MEETING", "SPORTS", "EVENT", "TRIP"]),
  label: z.string().min(1).max(200).trim(),
  date: z.string().datetime({ offset: true }).or(z.string().date()),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireInstitution(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

function formatPost(post: {
  id: string;
  type: string;
  title: string;
  body: string;
  subject: string | null;
  divisionId: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
  attachmentName: string | null;
  createdAt: Date;
  author: { id: string; name: string | null; role: string };
}) {
  return {
    id: post.id,
    type: post.type.toLowerCase() as "announcement" | "notice" | "material" | "result",
    title: post.title,
    body: post.body,
    subject: post.subject,
    divisionId: post.divisionId,
    attachmentUrl: post.attachmentUrl,
    attachmentType: post.attachmentType,
    attachmentName: post.attachmentName,
    createdAt: post.createdAt.toISOString(),
    author: {
      id: post.author.id,
      name: post.author.name ?? "Unknown",
      role: post.author.role,
    },
  };
}

// ── Feed posts ────────────────────────────────────────────────────────────────

export const listPosts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId: _uid } = requireInstitution(req);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const typeFilter = req.query.type as string | undefined;
    const divisionId = req.query.divisionId as string | undefined;

    const where = {
      institutionId,
      ...(divisionId ? { divisionId } : {}),
      ...(typeFilter && typeFilter !== "all"
        ? { type: typeFilter.toUpperCase() as "ANNOUNCEMENT" | "NOTICE" | "MATERIAL" | "RESULT" }
        : {}),
    };

    const [posts, total] = await prisma.$transaction([
      prisma.campusFeedPost.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { author: { select: { id: true, name: true, role: true } } },
      }),
      prisma.campusFeedPost.count({ where }),
    ]);

    res.json({
      success: true,
      data: posts.map(formatPost),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

export const createPost = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const data = createPostSchema.parse(req.body);

    const post = await prisma.campusFeedPost.create({
      data: {
        institutionId,
        authorId: userId,
        type: data.type,
        title: data.title,
        body: data.body,
        subject: data.subject,
        divisionId: data.divisionId ?? null,
        attachmentUrl: data.attachmentUrl,
        attachmentType: data.attachmentType,
        attachmentName: data.attachmentName,
      },
      include: { author: { select: { id: true, name: true, role: true } } },
    });

    res.status(201).json({ success: true, data: formatPost(post) });
    logAudit("ANNOUNCEMENT_POSTED", {
      userId,
      actorRole: req.user!.role,
      institutionId,
      details: `${data.type}: "${data.title}"`,
      category: "ADMIN_ACTION",
      severity: "INFO",
    });
  } catch (err) {
    next(err);
  }
};

export const deletePost = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const id = req.params.id as string;

    const post = await prisma.campusFeedPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");
    if (post.authorId !== userId && req.user!.role !== "ADMIN") {
      throw new BadRequestError("You can only delete your own posts");
    }

    await prisma.campusFeedPost.delete({ where: { id } });
    res.json({ success: true });
    logAudit("POST_DELETED", {
      userId,
      actorRole: req.user!.role,
      institutionId,
      details: `Post "${post.title}" deleted`,
      category: "ADMIN_ACTION",
      severity: "WARNING",
    });
  } catch (err) {
    next(err);
  }
};

// ── Calendar events ───────────────────────────────────────────────────────────

export const listEvents = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);

    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string); // 0-indexed
    const validMonth = Number.isNaN(month) ? new Date().getMonth() : month;

    const start = new Date(year, validMonth, 1);
    const end = new Date(year, validMonth + 1, 0, 23, 59, 59, 999);

    const events = await prisma.calendarEvent.findMany({
      where: { institutionId, date: { gte: start, lte: end } },
      orderBy: { date: "asc" },
      include: { createdBy: { select: { id: true, name: true } } },
    });

    const data = events.map(e => ({
      id: e.id,
      type: e.type.toLowerCase(),
      label: e.label,
      date: e.date.getUTCDate(),
      fullDate: e.date.toISOString(),
      createdBy: e.createdBy ? { id: e.createdBy.id, name: e.createdBy.name } : null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createEvent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const data = createEventSchema.parse(req.body);

    const event = await prisma.calendarEvent.create({
      data: {
        institutionId,
        createdById: userId,
        type: data.type,
        label: data.label,
        date: new Date(data.date),
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: event.id,
        type: event.type.toLowerCase(),
        label: event.label,
        date: event.date.getUTCDate(),
        fullDate: event.date.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
};

export const deleteEvent = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);
    const id = req.params.id as string;

    const event = await prisma.calendarEvent.findFirst({ where: { id, institutionId } });
    if (!event) throw new NotFoundError("Event not found");

    await prisma.calendarEvent.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
