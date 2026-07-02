import { Response, NextFunction, Request } from "express";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../utils/prisma";
import { uploadAttachmentToR2, scheduleR2FileDeletion, r2KeyFromUrl, generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { getPresenceBatch } from "../../services/presence.service";
import { z } from "zod";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require("multer");

// ── Multer (memory) ───────────────────────────────────────────────────────────

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50 MB — video upper bound
});

// ── Zod schemas ───────────────────────────────────────────────────────────────

const attachmentTypeEnum = z.enum(["image", "video", "file"]);

const createPostSchema = z.object({
  text: z.string().min(1).max(2000).trim(),
  attachmentUrl: z.string().url().optional(),
  attachmentType: attachmentTypeEnum.optional(),
  attachmentName: z.string().max(200).optional(),
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
  attachmentUrl: string | null;
  attachmentType: string | null;
  attachmentName: string | null;
  createdAt: Date;
  author: { id: string; name: string | null; role: string };
  reactions: { userId: string }[];
  comments: {
    id: string;
    text: string;
    createdAt: Date;
    author: { id: string; name: string | null; role: string };
  }[];
}, viewerId: string, authorAvatarUrl: string | null = null, commentAvatarMap: Map<string, string | null> = new Map()) {
  return {
    id: post.id,
    text: post.text,
    attachmentUrl: post.attachmentUrl,
    attachmentType: post.attachmentType,
    attachmentName: post.attachmentName,
    createdAt: post.createdAt.toISOString(),
    author: {
      id: post.author.id,
      name: post.author.name ?? "Unknown",
      role: post.author.role,
      avatarUrl: authorAvatarUrl,
    },
    likeCount: post.reactions.length,
    liked: post.reactions.some(r => r.userId === viewerId),
    comments: post.comments.map(c => ({
      id: c.id,
      text: c.text,
      createdAt: c.createdAt.toISOString(),
      author: { id: c.author.id, name: c.author.name ?? "Unknown", role: c.author.role, avatarUrl: commentAvatarMap.get(c.author.id) ?? null },
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

    const [posts, total] = await prisma.$transaction([
      prisma.staffPost.findMany({
        where: { institutionId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          author: { select: { id: true, name: true, role: true, teacher: { select: { avatarUrl: true } } } },
          reactions: { select: { userId: true } },
          comments: {
            orderBy: { createdAt: "asc" },
            include: { author: { select: { id: true, name: true, role: true, teacher: { select: { avatarUrl: true } } } } },
          },
        },
      }),
      prisma.staffPost.count({ where: { institutionId } }),
    ]);

    type PostWithTeacher = typeof posts[0];
    type AuthorWithTeacher = PostWithTeacher['author'];
    const getTeacherAvatar = (author: AuthorWithTeacher) => (author as { teacher?: { avatarUrl?: string | null } | null }).teacher?.avatarUrl ?? null;

    const allRawUrls = [
      ...posts.map(p => getTeacherAvatar(p.author)),
      ...posts.flatMap(p => p.comments.map(c => getTeacherAvatar(c.author))),
    ];
    const signedMap = await generateSignedAvatarUrlsBatch(allRawUrls);
    const resolveAvatar = (url: string | null | undefined) => url ? (signedMap[url] ?? url) : null;

    const commentAvatarMaps = posts.map(p => {
      const m = new Map<string, string | null>();
      for (const c of p.comments) m.set(c.author.id, resolveAvatar(getTeacherAvatar(c.author)));
      return m;
    });

    res.json({
      success: true,
      data: posts.map((p, i) => formatPost(p, userId, resolveAvatar(getTeacherAvatar(p.author)), commentAvatarMaps[i])),
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

    const post = await prisma.staffPost.create({
      data: {
        institutionId,
        authorId: userId,
        text: data.text,
        attachmentUrl: data.attachmentUrl,
        attachmentType: data.attachmentType,
        attachmentName: data.attachmentName,
      },
      include: {
        author: { select: { id: true, name: true, role: true, teacher: { select: { avatarUrl: true } } } },
        reactions: { select: { userId: true } },
        comments: {
          orderBy: { createdAt: "asc" },
          include: { author: { select: { id: true, name: true, role: true, teacher: { select: { avatarUrl: true } } } } },
        },
      },
    });

    const rawUrl = (post.author as { teacher?: { avatarUrl?: string | null } | null }).teacher?.avatarUrl ?? null;
    const signedMap2 = await generateSignedAvatarUrlsBatch([rawUrl]);
    const authorAvatarUrl = rawUrl ? (signedMap2[rawUrl] ?? rawUrl) : null;

    res.status(201).json({ success: true, data: formatPost(post, userId, authorAvatarUrl) });
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

    const post = await prisma.staffPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");
    if (post.authorId !== userId && role !== "ADMIN") {
      throw new BadRequestError("You can only delete your own posts");
    }

    await prisma.staffPost.delete({ where: { id } });

    // Schedule R2 attachment deletion after grace period
    if (post.attachmentUrl) {
      const key = r2KeyFromUrl(post.attachmentUrl);
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

    const post = await prisma.staffPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");

    const existing = await prisma.staffPostReaction.findUnique({
      where: { postId_userId: { postId: id, userId } },
    });

    if (existing) {
      await prisma.staffPostReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.staffPostReaction.create({
        data: { postId: id, userId, institutionId },
      });
    }

    const likeCount = await prisma.staffPostReaction.count({ where: { postId: id } });
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

    const post = await prisma.staffPost.findFirst({ where: { id, institutionId } });
    if (!post) throw new NotFoundError("Post not found");

    const comment = await prisma.staffPostComment.create({
      data: { postId: id, authorId: userId, institutionId, text: data.text },
      include: { author: { select: { id: true, name: true, role: true } } },
    });

    res.status(201).json({
      success: true,
      data: {
        id: comment.id,
        text: comment.text,
        createdAt: comment.createdAt.toISOString(),
        author: {
          id: comment.author.id,
          name: comment.author.name ?? "Unknown",
          role: comment.author.role,
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

    const comment = await prisma.staffPostComment.findFirst({
      where: { id: commentId, institutionId },
    });
    if (!comment) throw new NotFoundError("Comment not found");
    if (comment.authorId !== userId && role !== "ADMIN") {
      throw new BadRequestError("You can only delete your own comments");
    }

    await prisma.staffPostComment.delete({ where: { id: commentId } });
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
    };

    let contacts: Contact[] = [];

    if (role === "ADMIN") {
      // Admin sees all teachers
      const teachers = await prisma.teacher.findMany({
        where: { institutionId },
        include: { user: { select: { id: true, name: true, isActive: true } } },
        orderBy: { createdAt: "asc" },
      });
      contacts = teachers.map((t) => ({
        teacherId: t.id,
        contactUserId: t.userId,
        name: t.user.name ?? "Unknown",
        avatarUrl: t.avatarUrl,
        isActive: t.user.isActive,
      }));
    } else {
      // Teacher sees other teachers (not self) + admin users
      const [teachers, admins] = await Promise.all([
        prisma.teacher.findMany({
          where: { institutionId, userId: { not: userId } },
          include: { user: { select: { id: true, name: true, isActive: true } } },
          orderBy: { createdAt: "asc" },
        }),
        prisma.user.findMany({
          where: { institutionId, role: "ADMIN" },
          select: { id: true, name: true, isActive: true },
          orderBy: { name: "asc" },
        }),
      ]);
      contacts = [
        ...admins.map((a) => ({
          teacherId: a.id,
          contactUserId: a.id,
          name: a.name ?? "Admin",
          avatarUrl: null,
          isActive: a.isActive,
        })),
        ...teachers.map((t) => ({
          teacherId: t.id,
          contactUserId: t.userId,
          name: t.user.name ?? "Unknown",
          avatarUrl: t.avatarUrl,
          isActive: t.user.isActive,
        })),
      ];
    }

    const presenceMap = await getPresenceBatch(contacts.map((c) => c.contactUserId));
    // If Redis is unavailable (empty map), fall back to the static DB isActive field
    const redisAvailable = Object.keys(presenceMap).length > 0 || contacts.length === 0;

    const threads = await Promise.all(
      contacts.map(async (c) => {
        const lastMessage = await prisma.staffMessage.findFirst({
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

        const unread = await prisma.staffMessage.count({
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
          avatarUrl: c.avatarUrl,
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
        role: { in: ["TEACHER", "ADMIN"] },
        OR: [
          { institutionId },
          { teacher: { institutionId } },
        ],
      },
    });
    if (!contact) throw new NotFoundError("User not found");

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 50);

    const messages = await prisma.staffMessage.findMany({
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
    await prisma.staffMessage.updateMany({
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
        role: { in: ["TEACHER", "ADMIN"] },
        OR: [
          { institutionId },
          { teacher: { institutionId } },
        ],
      },
    });
    if (!contact) throw new NotFoundError("User not found");

    const message = await prisma.staffMessage.create({
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

export const markRead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { institutionId, userId } = requireInstitution(req);
    const teacherUserId = req.params.teacherUserId as string;

    await prisma.staffMessage.updateMany({
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
