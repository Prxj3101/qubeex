import { Response, NextFunction, Request } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl, generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { getPresenceBatch } from "../../services/presence.service";
import { resolveAuthorDisplay, DisplayInfo } from "../../utils/authorDisplay";
import { z } from "zod";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");

const UNSEND_WINDOW_MS = 60 * 60 * 1000;

// ── Multer (memory) ───────────────────────────────────────────────────────────

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50 MB — video upper bound
});

// ── Zod schemas ───────────────────────────────────────────────────────────────

const attachmentTypeEnum = z.enum(["image", "video", "file"]);

const attachmentItemSchema = z.object({
  url: z.string().url(),
  type: attachmentTypeEnum,
  name: z.string().max(200),
});

const createPostSchema = z.object({
  text: z.string().min(1).max(2000).trim(),
  attachments: z.array(attachmentItemSchema).max(10).optional(),
});

const createCommentSchema = z.object({
  text: z.string().min(1).max(500).trim(),
});

const sendMessageSchema = z.object({
  text: z.string().max(2000).trim().optional(),
  attachmentUrl: z.string().url().optional(),
  attachmentType: attachmentTypeEnum.optional(),
  attachmentName: z.string().max(200).optional(),
}).refine(d => d.text || d.attachmentUrl, {
  message: "Message must have text or an attachment",
});

// ── Helper ────────────────────────────────────────────────────────────────────

function requireInstitution(req: AuthRequest) {
  const { institutionId, userId, role } = req.user!;
  if (!institutionId) throw new BadRequestError("No institution associated with this account");
  return { institutionId, userId, role };
}

function formatPost(post: {
  id: string;
  text: string;
  attachments: unknown;
  createdAt: Date;
  author: { id: string; name: string | null; role: string };
  reactions: { userId: string }[];
  comments: {
    id: string;
    text: string;
    createdAt: Date;
    author: { id: string; name: string | null; role: string };
  }[];
}, viewerId: string, authorAvatarUrl: string | null = null, commentAvatarMap: Map<string, string | null> = new Map(), displayMap: Map<string, DisplayInfo> = new Map()) {
  return {
    id: post.id,
    text: post.text,
    attachments: Array.isArray(post.attachments) ? post.attachments : [],
    createdAt: post.createdAt.toISOString(),
    author: {
      id: post.author.id,
      name: post.author.name ?? "Unknown",
      role: post.author.role,
      avatarUrl: authorAvatarUrl,
      prefix: displayMap.get(post.author.id)?.prefix ?? null,
      title: displayMap.get(post.author.id)?.title ?? null,
    },
    likeCount: post.reactions.length,
    liked: post.reactions.some(r => r.userId === viewerId),
    comments: post.comments.map(c => ({
      id: c.id,
      text: c.text,
      createdAt: c.createdAt.toISOString(),
      author: {
        id: c.author.id,
        name: c.author.name ?? "Unknown",
        role: c.author.role,
        avatarUrl: commentAvatarMap.get(c.author.id) ?? null,
        prefix: displayMap.get(c.author.id)?.prefix ?? null,
        title: displayMap.get(c.author.id)?.title ?? null,
      },
    })),
  };
}

// ── Upload attachment ─────────────────────────────────────────────────────────

export const uploadAttachment = async (
  req: AuthRequest & { file?: Express.Multer.File },
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId } = requireInstitution(req);

    const file = req.file;
    if (!file) throw new BadRequestError("No file provided");

    const context = (req.query.context as string) === "dm" ? "dms" : "posts";
    const result = await uploadAttachmentToR2(file.buffer, {
      originalName:  file.originalname,
      contentType:   file.mimetype,
      institutionId,
      area:          `staffroom/${context}`,
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
    console.error("[staffroom upload error]", err);
    next(err);
  }
};

// ── Feed ──────────────────────────────────────────────────────────────────────

export const listPosts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

    const [postsRaw, total] = await prisma.$transaction([
      academicDb().staffPost.findMany({
        where: { institutionId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          reactions: { select: { userId: true } },
          comments: { orderBy: { createdAt: "asc" } },
        },
      }),
      academicDb().staffPost.count({ where: { institutionId } }),
    ]);

    const allAuthorIds = [
      ...postsRaw.map(p => p.authorId),
      ...postsRaw.flatMap(p => p.comments.map(c => c.authorId)),
    ];
    const authorUserMap = await resolveUsers(allAuthorIds, { id: true, name: true, role: true });
    const authorOf = (authorId: string) => authorUserMap.get(authorId) ?? { id: authorId, name: null, role: "ADMIN" };

    const posts = postsRaw.map(p => ({
      ...p,
      author: authorOf(p.authorId),
      comments: p.comments.map(c => ({ ...c, author: authorOf(c.authorId) })),
    }));

    // resolveAuthorDisplay already resolves Teacher avatarUrl (via academicDb().teacher)
    // for TEACHER authors, and Institution/SubAdmin avatarUrl for the others.
    const allAuthors = [
      ...posts.map(p => p.author),
      ...posts.flatMap(p => p.comments.map(c => c.author)),
    ];
    const displayMap = await resolveAuthorDisplay(allAuthors, institutionId);
    const getRawAvatarUrl = (author: { id: string }) => displayMap.get(author.id)?.avatarUrl ?? null;

    const allRawUrls = [
      ...posts.map(p => getRawAvatarUrl(p.author)),
      ...posts.flatMap(p => p.comments.map(c => getRawAvatarUrl(c.author))),
    ];
    const signedMap = await generateSignedAvatarUrlsBatch(allRawUrls);
    const resolveAvatar = (url: string | null | undefined) => url ? (signedMap[url] ?? url) : null;

    const commentAvatarMaps = posts.map(p => {
      const m = new Map<string, string | null>();
      for (const c of p.comments) m.set(c.author.id, resolveAvatar(getRawAvatarUrl(c.author)));
      return m;
    });

    res.json({
      success: true,
      data: posts.map((p, i) => formatPost(p, userId, resolveAvatar(getRawAvatarUrl(p.author)), commentAvatarMaps[i], displayMap)),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

export const createPost = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const data = createPostSchema.parse(req.body);

    const postRaw = await academicDb().staffPost.create({
      data: {
        institutionId,
        authorId: userId,
        text: data.text,
        attachments: data.attachments ?? undefined,
      },
      include: {
        reactions: { select: { userId: true } },
        comments: { orderBy: { createdAt: "asc" } },
      },
    });
    const createPostAuthorUserMap = await resolveUsers([postRaw.authorId], { id: true, name: true, role: true });
    const post = { ...postRaw, author: createPostAuthorUserMap.get(postRaw.authorId) ?? { id: postRaw.authorId, name: null, role: "ADMIN" }, comments: [] as never[] };

    const displayMap = await resolveAuthorDisplay([post.author], institutionId);
    const rawUrl = displayMap.get(post.author.id)?.avatarUrl ?? null;
    const signedMap2 = await generateSignedAvatarUrlsBatch([rawUrl]);
    const authorAvatarUrl = rawUrl ? (signedMap2[rawUrl] ?? rawUrl) : null;

    res.status(201).json({ success: true, data: formatPost(post, userId, authorAvatarUrl, new Map(), displayMap) });
  } catch (err) {
    next(err);
  }
};

export const deletePost = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId, role } = requireInstitution(req);
    const id = req.params.id as string;

    const post = await academicDb().staffPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");
    if (post.authorId !== userId && role !== "ADMIN") {
      throw new BadRequestError("You can only delete your own posts");
    }

    await academicDb().staffPost.delete({ where: { id } });

    // Schedule R2 attachment deletion after grace period — for each
    // attachment in the array now, instead of a single scalar URL.
    const attachmentsToClean = Array.isArray(post.attachments) ? post.attachments : [];
    for (const att of attachmentsToClean) {
      const url = (att as { url?: string })?.url;
      if (!url) continue;
      const key = r2KeyFromUrl(url);
      if (key) await scheduleR2FileDeletion(key);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const toggleLike = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const id = req.params.id as string;

    const post = await academicDb().staffPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");

    const existing = await academicDb().staffPostReaction.findUnique({
      where: { postId_userId: { postId: id, userId } },
    });

    if (existing) {
      await academicDb().staffPostReaction.delete({ where: { id: existing.id } });
    } else {
      await academicDb().staffPostReaction.create({
        data: { postId: id, userId, institutionId },
      });
    }

    const likeCount = await academicDb().staffPostReaction.count({ where: { postId: id } });
    res.json({ success: true, data: { liked: !existing, likeCount } });
  } catch (err) {
    next(err);
  }
};

export const addComment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const id = req.params.id as string;
    const data = createCommentSchema.parse(req.body);

    const post = await academicDb().staffPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");

    const comment = await academicDb().staffPostComment.create({
      data: { postId: id, authorId: userId, institutionId, text: data.text },
    });
    const commentAuthorUserMap = await resolveUsers([comment.authorId], { id: true, name: true, role: true });
    const commentAuthor = commentAuthorUserMap.get(comment.authorId) ?? { id: comment.authorId, name: null, role: "ADMIN" };

    const displayMap = await resolveAuthorDisplay([commentAuthor], institutionId);
    const rawUrl = displayMap.get(commentAuthor.id)?.avatarUrl ?? null;
    const signedMap = await generateSignedAvatarUrlsBatch([rawUrl]);
    const avatarUrl = rawUrl ? (signedMap[rawUrl] ?? rawUrl) : null;

    res.status(201).json({
      success: true,
      data: {
        id: comment.id,
        text: comment.text,
        createdAt: comment.createdAt.toISOString(),
        author: {
          id: commentAuthor.id,
          name: commentAuthor.name ?? "Unknown",
          role: commentAuthor.role,
          avatarUrl,
          prefix: displayMap.get(commentAuthor.id)?.prefix ?? null,
          title: displayMap.get(commentAuthor.id)?.title ?? null,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

export const deleteComment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId, role } = requireInstitution(req);
    const commentId = req.params.commentId as string;

    const comment = await academicDb().staffPostComment.findFirst({
      where: { id: commentId, institutionId },
    });
    if (!comment) throw new NotFoundError("Comment not found");
    if (comment.authorId !== userId && role !== "ADMIN") {
      throw new BadRequestError("You can only delete your own comments");
    }

    await academicDb().staffPostComment.delete({ where: { id: commentId } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ── DMs ───────────────────────────────────────────────────────────────────────

export const listDmThreads = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId, role } = requireInstitution(req);

    type Contact = {
      teacherId: string;
      contactUserId: string;
      name: string;
      avatarUrl: string | null;
      isActive: boolean;
      prefix: string | null;
      title: string | null;
    };

    const institution = await prisma.institution.findUnique({
      where: { id: institutionId },
      select: { adminPrefix: true, adminTitle: true, adminAvatarUrl: true },
    });

    let contacts: Contact[] = [];

    if (role === "ADMIN") {
      // Admin sees all teachers + sub-admins
      const [teachers, subAdmins] = await Promise.all([
        academicDb().teacher.findMany({
          where: { institutionId },
          orderBy: { createdAt: "asc" },
        }),
        prisma.subAdmin.findMany({
          where: { institutionId },
          include: { user: { select: { id: true, name: true, isActive: true } } },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      const teacherUsers = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true, isActive: true });
      contacts = [
        ...teachers.map((t) => ({
          teacherId: t.id,
          contactUserId: t.userId,
          name: teacherUsers.get(t.userId)?.name ?? "Unknown",
          avatarUrl: t.avatarUrl,
          isActive: teacherUsers.get(t.userId)?.isActive ?? false,
          prefix: t.prefix,
          title: t.title,
        })),
        ...subAdmins.map((s) => ({
          teacherId: s.id,
          contactUserId: s.userId,
          name: s.user.name ?? "Sub Admin",
          avatarUrl: s.avatarUrl,
          isActive: s.user.isActive,
          prefix: s.prefix,
          title: s.designation,
        })),
      ];
    } else {
      // Teacher sees other teachers (not self) + admin + sub-admin users
      const [teachers, admins, subAdmins] = await Promise.all([
        academicDb().teacher.findMany({
          where: { institutionId, userId: { not: userId } },
          orderBy: { createdAt: "asc" },
        }),
        prisma.user.findMany({
          where: { institutionId, role: "ADMIN" },
          select: { id: true, name: true, isActive: true },
          orderBy: { name: "asc" },
        }),
        prisma.subAdmin.findMany({
          where: { institutionId, userId: { not: userId } },
          include: { user: { select: { id: true, name: true, isActive: true } } },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      const teacherUsers = await resolveUsers(teachers.map((t) => t.userId), { id: true, name: true, isActive: true });
      contacts = [
        ...admins.map((a) => ({
          teacherId: a.id,
          contactUserId: a.id,
          name: a.name ?? "Admin",
          avatarUrl: institution?.adminAvatarUrl ?? null,
          isActive: a.isActive,
          prefix: institution?.adminPrefix ?? null,
          title: institution?.adminTitle ?? null,
        })),
        ...subAdmins.map((s) => ({
          teacherId: s.id,
          contactUserId: s.userId,
          name: s.user.name ?? "Sub Admin",
          avatarUrl: s.avatarUrl,
          isActive: s.user.isActive,
          prefix: s.prefix,
          title: s.designation,
        })),
        ...teachers.map((t) => ({
          teacherId: t.id,
          contactUserId: t.userId,
          name: teacherUsers.get(t.userId)?.name ?? "Unknown",
          avatarUrl: t.avatarUrl,
          isActive: teacherUsers.get(t.userId)?.isActive ?? false,
          prefix: t.prefix,
          title: t.title,
        })),
      ];
    }

    const presenceMap = await getPresenceBatch(contacts.map((c) => c.contactUserId));
    // If Redis is unavailable (empty map), fall back to the static DB isActive field
    const redisAvailable = Object.keys(presenceMap).length > 0 || contacts.length === 0;

    const signedContactAvatars = await generateSignedAvatarUrlsBatch(contacts.map((c) => c.avatarUrl));
    const resolveContactAvatar = (url: string | null) => url ? (signedContactAvatars[url] ?? url) : null;

    const threads = await Promise.all(
      contacts.map(async (c) => {
        const lastMessage = await academicDb().staffMessage.findFirst({
          where: {
            institutionId,
            OR: [
              { senderId: userId, receiverId: c.contactUserId },
              { senderId: c.contactUserId, receiverId: userId },
            ],
          },
          orderBy: { createdAt: "desc" },
          select: { text: true, attachmentName: true, createdAt: true, senderId: true },
        });

        const unread = await academicDb().staffMessage.count({
          where: {
            institutionId,
            senderId: c.contactUserId,
            receiverId: userId,
            readAt: null,
          },
        });

        return {
          teacherId: c.teacherId,
          teacherUserId: c.contactUserId,
          name: c.name,
          avatarUrl: resolveContactAvatar(c.avatarUrl),
          prefix: c.prefix,
          title: c.title,
          isActive: redisAvailable ? (presenceMap[c.contactUserId] ?? false) : c.isActive,
          lastMessage: lastMessage
            ? (lastMessage.text ?? lastMessage.attachmentName ?? "Attachment")
            : null,
          lastMessageAt: lastMessage?.createdAt.toISOString() ?? null,
          lastMessageIsMe: lastMessage?.senderId === userId,
          unread,
        };
      })
    );

    res.json({ success: true, data: threads });
  } catch (err) {
    next(err);
  }
};

export const getMessages = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const teacherUserId = req.params.teacherUserId as string;

    const contact = await prisma.user.findFirst({
      where: {
        id: teacherUserId,
        role: { in: ["TEACHER", "ADMIN", "SUB_ADMIN"] },
        OR: [
          { institutionId },
          { teacher: { institutionId } },
        ],
      },
    });
    if (!contact) throw new NotFoundError("User not found");

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 50);

    const messages = await academicDb().staffMessage.findMany({
      where: {
        institutionId,
        OR: [
          { senderId: userId, receiverId: teacherUserId },
          { senderId: teacherUserId, receiverId: userId },
        ],
      },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        senderId: true,
        text: true,
        attachmentUrl: true,
        attachmentType: true,
        attachmentName: true,
        readAt: true,
        createdAt: true,
      },
    });

    // Mark unread messages from teacher as read
    await academicDb().staffMessage.updateMany({
      where: {
        institutionId,
        senderId: teacherUserId,
        receiverId: userId,
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    res.json({
      success: true,
      data: messages.map(m => ({
        id: m.id,
        isMe: m.senderId === userId,
        text: m.text,
        attachmentUrl: m.attachmentUrl,
        attachmentType: m.attachmentType,
        attachmentName: m.attachmentName,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
};

export const sendMessage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const teacherUserId = req.params.teacherUserId as string;
    const data = sendMessageSchema.parse(req.body);

    const contact = await prisma.user.findFirst({
      where: {
        id: teacherUserId,
        role: { in: ["TEACHER", "ADMIN", "SUB_ADMIN"] },
        OR: [
          { institutionId },
          { teacher: { institutionId } },
        ],
      },
    });
    if (!contact) throw new NotFoundError("User not found");

    const message = await academicDb().staffMessage.create({
      data: {
        institutionId,
        senderId: userId,
        receiverId: teacherUserId,
        text: data.text,
        attachmentUrl: data.attachmentUrl,
        attachmentType: data.attachmentType,
        attachmentName: data.attachmentName,
      },
      select: {
        id: true,
        senderId: true,
        text: true,
        attachmentUrl: true,
        attachmentType: true,
        attachmentName: true,
        createdAt: true,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: message.id,
        isMe: true,
        text: message.text,
        attachmentUrl: message.attachmentUrl,
        attachmentType: message.attachmentType,
        attachmentName: message.attachmentName,
        createdAt: message.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
};

export const unsendMessage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const messageId = req.params.messageId as string;

    const message = await academicDb().staffMessage.findFirst({ where: { id: messageId, institutionId } });
    if (!message) throw new NotFoundError("Message not found");
    if (message.senderId !== userId) {
      throw new BadRequestError("You can only unsend your own messages");
    }
    if (Date.now() - message.createdAt.getTime() > UNSEND_WINDOW_MS) {
      throw new BadRequestError("Messages can only be unsent within 1 hour of sending");
    }

    await academicDb().staffMessage.delete({ where: { id: messageId } });

    if (message.attachmentUrl) {
      const key = r2KeyFromUrl(message.attachmentUrl);
      if (key) await scheduleR2FileDeletion(key);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const markRead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const teacherUserId = req.params.teacherUserId as string;

    await academicDb().staffMessage.updateMany({
      where: {
        institutionId,
        senderId: teacherUserId,
        receiverId: userId,
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// Suppress unused import warning — Request is used by multer type augmentation
void (null as unknown as Request);
