import { Response, NextFunction } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { academicDb } from "../../utils/academicContext";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl, generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { z } from "zod";
import { logAudit } from "../../services/audit.service";
import { resolveAuthorDisplay, DisplayInfo } from "../../utils/authorDisplay";
import { resolveUsers } from "../../services/userLookup.service";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50 MB — video upper bound
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const createPostSchema = z.object({
  type: z.enum(["ANNOUNCEMENT", "NOTICE", "MATERIAL", "RESULT"]),
  title: z.string().min(1).max(300).trim(),
  body: z.string().max(5000).trim().optional().default(""),
  subject: z.string().max(100).trim().optional(),
  subjectId: z.string().uuid().optional(),
  divisionId: z.string().uuid().optional(),
  attachmentUrl: z.string().url().optional(),
  attachmentType: z.string().max(20).optional(),
  attachmentName: z.string().max(200).optional(),
});

const createEventSchema = z.object({
  type: z.enum(["HOLIDAY", "TEST", "TERMTEST", "EXAM", "SUBMISSION", "MEETING", "SPORTS", "EVENT", "TRIP"]),
  label: z.string().min(1).max(200).trim(),
  date: z.string().datetime({ offset: true }).or(z.string().date()),
  divisionId: z.string().uuid().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireInstitution(req: AuthRequest) {
  const { institutionId, userId } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId };
}

function formatPost(
  post: {
    id: string; type: string; title: string; body: string; subject: string | null;
    subjectId?: string | null;
    divisionId: string | null; attachmentUrl: string | null; attachmentType: string | null;
    attachmentName: string | null; createdAt: Date;
    author: { id: string; name: string | null; role: string };
  },
  authorAvatarUrl: string | null = null,
  displayInfo: DisplayInfo | undefined = undefined
) {
  return {
    id: post.id,
    type: post.type.toLowerCase() as "announcement" | "notice" | "material" | "result",
    title: post.title,
    body: post.body,
    subject: post.subject,
    subjectId: post.subjectId ?? null,
    divisionId: post.divisionId,
    attachmentUrl: post.attachmentUrl,
    attachmentType: post.attachmentType,
    attachmentName: post.attachmentName,
    createdAt: post.createdAt.toISOString(),
    author: {
      id: post.author.id,
      name: post.author.name ?? "Unknown",
      role: post.author.role,
      avatarUrl: authorAvatarUrl,
      prefix: displayInfo?.prefix ?? null,
      title: displayInfo?.title ?? null,
    },
  };
}

// ── Upload attachment ─────────────────────────────────────────────────────────

export const uploadFeedAttachment = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId } = requireInstitution(req);
    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");

    const result = await uploadAttachmentToR2(file.buffer, {
      originalName:  file.originalname,
      contentType:   file.mimetype,
      institutionId,
      area:          "feed",
    });

    res.json({
      success: true,
      data: {
        url: result.publicUrl,
        name: file.originalname,
        type: result.attachmentType,
        mimeType: file.mimetype,
        size: file.size,
      },
    });
  } catch (err) {
    console.error("[feed upload error]", err);
    next(err);
  }
};

// ── Feed posts ────────────────────────────────────────────────────────────────

export const listPosts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId, userId: _uid } = requireInstitution(req);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const typeFilter = req.query.type as string | undefined;
    const divisionId = req.query.divisionId as string | undefined;

    const typeCondition = typeFilter && typeFilter !== "all"
      ? { type: typeFilter.toUpperCase() as "ANNOUNCEMENT" | "NOTICE" | "MATERIAL" | "RESULT" }
      : {};

    // Strict separation: class feed shows only that class's posts, main feed shows only institution-wide posts
    const where = divisionId
      ? { institutionId, divisionId, ...typeCondition }
      : { institutionId, divisionId: null, ...typeCondition };

    const [posts, total] = await academicDb().$transaction([
      academicDb().campusFeedPost.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      academicDb().campusFeedPost.count({ where }),
    ]);

    const feedAuthorUserMap = await resolveUsers(posts.map(p => p.authorId), { id: true, name: true, role: true });
    const postsWithAuthor = posts.map(p => ({ ...p, author: feedAuthorUserMap.get(p.authorId) ?? { id: p.authorId, name: null, role: "ADMIN" } }));

    const displayMap = await resolveAuthorDisplay(postsWithAuthor.map(p => p.author), institutionId);
    const rawAvatarUrls = postsWithAuthor.map(p => displayMap.get(p.author.id)?.avatarUrl ?? null);
    const signedMap = await generateSignedAvatarUrlsBatch(rawAvatarUrls);
    const resolveAvatar = (url: string | null | undefined) => url ? (signedMap[url] ?? url) : null;

    res.json({
      success: true,
      data: postsWithAuthor.map(p => formatPost(p, resolveAvatar(displayMap.get(p.author.id)?.avatarUrl), displayMap.get(p.author.id))),
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

    let subjectName = data.subject;

    if (data.subjectId) {
      const subject = await academicDb().subject.findFirst({
        where: { id: data.subjectId, institutionId },
        select: { id: true, name: true },
      });
      if (!subject) throw new NotFoundError("Subject not found");
      subjectName = subject.name;

      // A teacher (not admin) may only tag a subject they're actually assigned to
      // teach in that division, or if they're the division's class teacher.
      if (req.user!.role === "TEACHER" && data.divisionId) {
        const teacher = await academicDb().teacher.findFirst({ where: { userId, institutionId }, select: { id: true } });
        const assignment = teacher
          ? await academicDb().divisionAssignment.findFirst({
              where: {
                divisionId: data.divisionId,
                teacherId: teacher.id,
                institutionId,
                OR: [{ subjectId: data.subjectId }, { subjectId: null }],
              },
              select: { id: true },
            })
          : null;
        if (!assignment) throw new BadRequestError("You can only post materials for a subject you teach in this class");
      }
    }

    const post = await academicDb().campusFeedPost.create({
      data: {
        institutionId,
        authorId: userId,
        type: data.type,
        title: data.title,
        body: data.body,
        subject: subjectName,
        subjectId: data.subjectId ?? null,
        divisionId: data.divisionId ?? null,
        attachmentUrl: data.attachmentUrl,
        attachmentType: data.attachmentType,
        attachmentName: data.attachmentName,
      },
    });
    const createFeedAuthorUserMap = await resolveUsers([post.authorId], { id: true, name: true, role: true });
    const postWithAuthor = { ...post, author: createFeedAuthorUserMap.get(post.authorId) ?? { id: post.authorId, name: null, role: "ADMIN" } };

    const displayMap = await resolveAuthorDisplay([postWithAuthor.author], institutionId);
    const rawUrl = displayMap.get(postWithAuthor.author.id)?.avatarUrl ?? null;
    const signedMap2 = await generateSignedAvatarUrlsBatch([rawUrl]);
    const authorAvatarUrl = rawUrl ? (signedMap2[rawUrl] ?? rawUrl) : null;

    res.status(201).json({ success: true, data: formatPost(postWithAuthor, authorAvatarUrl, displayMap.get(postWithAuthor.author.id)) });
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

    const post = await academicDb().campusFeedPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");
    if (post.authorId !== userId && req.user!.role !== "ADMIN") {
      throw new BadRequestError("You can only delete your own posts");
    }

    await academicDb().campusFeedPost.delete({ where: { id } });

    // Schedule R2 attachment deletion after grace period
    if (post.attachmentUrl) {
      const key = r2KeyFromUrl(post.attachmentUrl);
      if (key) await scheduleR2FileDeletion(key).catch(() => {});
    }

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
    const divisionId = req.query.divisionId as string | undefined;

    const start = new Date(year, validMonth, 1);
    const end = new Date(year, validMonth + 1, 0, 23, 59, 59, 999);

    // Strict separation: class calendar shows only that class's events, main calendar shows only institution-wide
    const where = divisionId
      ? { institutionId, date: { gte: start, lte: end }, divisionId }
      : { institutionId, date: { gte: start, lte: end }, divisionId: null };

    const events = await academicDb().calendarEvent.findMany({
      where,
      orderBy: { date: "asc" },
    });
    const eventCreatorUserMap = await resolveUsers(events.map(e => e.createdById), { id: true, name: true });

    const data = events.map(e => ({
      id: e.id,
      type: e.type.toLowerCase(),
      label: e.label,
      date: e.date.getUTCDate(),
      fullDate: e.date.toISOString(),
      divisionId: e.divisionId,
      createdBy: eventCreatorUserMap.get(e.createdById) ?? null,
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

    // Only admins can create institution-wide (main calendar) events
    if (!data.divisionId && req.user!.role === "TEACHER") {
      throw new BadRequestError("Teachers can only add events to class calendars");
    }

    const event = await academicDb().calendarEvent.create({
      data: {
        institutionId,
        createdById: userId,
        type: data.type,
        label: data.label,
        date: new Date(data.date),
        divisionId: data.divisionId ?? null,
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

    const event = await academicDb().calendarEvent.findFirst({ where: { id, institutionId } });
    if (!event) throw new NotFoundError("Event not found");

    await academicDb().calendarEvent.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ── Merged feed posts (for students) — general + class combined ───────────────

export const listMergedPosts = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const typeFilter = req.query.type as string | undefined;
    const divisionId = req.query.divisionId as string | undefined;

    const typeCondition = typeFilter && typeFilter !== "all"
      ? { type: typeFilter.toUpperCase() as "ANNOUNCEMENT" | "NOTICE" | "MATERIAL" | "RESULT" }
      : {};

    // Merge: general (divisionId=null) + student's class posts
    const where = divisionId
      ? { institutionId, OR: [{ divisionId: null }, { divisionId }], ...typeCondition }
      : { institutionId, divisionId: null, ...typeCondition };

    const [posts, total] = await academicDb().$transaction([
      academicDb().campusFeedPost.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      academicDb().campusFeedPost.count({ where }),
    ]);

    const mergedAuthorUserMap = await resolveUsers(posts.map(p => p.authorId), { id: true, name: true, role: true });
    const postsWithAuthorMerged = posts.map(p => ({ ...p, author: mergedAuthorUserMap.get(p.authorId) ?? { id: p.authorId, name: null, role: "ADMIN" } }));

    const displayMapMerged = await resolveAuthorDisplay(postsWithAuthorMerged.map(p => p.author), institutionId);
    const rawAvatarUrlsMerged = postsWithAuthorMerged.map(p => displayMapMerged.get(p.author.id)?.avatarUrl ?? null);
    const signedMapMerged = await generateSignedAvatarUrlsBatch(rawAvatarUrlsMerged);
    const resolveAvatarMerged = (url: string | null | undefined) => url ? (signedMapMerged[url] ?? url) : null;

    res.json({
      success: true,
      data: postsWithAuthorMerged.map(p => ({ ...formatPost(p, resolveAvatarMerged(displayMapMerged.get(p.author.id)?.avatarUrl), displayMapMerged.get(p.author.id)), source: p.divisionId ? "class" : "general" })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── Merged calendar (for students) — main + class events combined ─────────────

export const listMergedEvents = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { institutionId } = requireInstitution(req);

    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string);
    const validMonth = Number.isNaN(month) ? new Date().getMonth() : month;
    const divisionId = req.query.divisionId as string | undefined;

    const start = new Date(year, validMonth, 1);
    const end = new Date(year, validMonth + 1, 0, 23, 59, 59, 999);

    // Fetch main (institution-wide) + class events in one query
    const where = divisionId
      ? { institutionId, date: { gte: start, lte: end }, OR: [{ divisionId }, { divisionId: null }] }
      : { institutionId, date: { gte: start, lte: end }, divisionId: null };

    const events = await academicDb().calendarEvent.findMany({
      where,
      orderBy: { date: "asc" },
    });
    const mergedEventCreatorUserMap = await resolveUsers(events.map(e => e.createdById), { id: true, name: true });

    const data = events.map(e => ({
      id: e.id,
      type: e.type.toLowerCase(),
      label: e.label,
      date: e.date.getUTCDate(),
      fullDate: e.date.toISOString(),
      divisionId: e.divisionId,
      isClassEvent: !!e.divisionId,
      createdBy: mergedEventCreatorUserMap.get(e.createdById) ?? null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
