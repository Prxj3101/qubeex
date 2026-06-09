import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { prisma } from "../../utils/prisma";
import bcrypt from "bcrypt";
import PDFDocument from "pdfkit";
import { z } from "zod";

const BCRYPT_ROUNDS = 12;

function generateStudentPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!";
  return Array.from(
    { length: 10 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

const addStudentSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email().toLowerCase().trim().optional().or(z.literal("")),
  dob: z.string().optional(),
  gender: z.string().optional(),
  phone: z.string().max(20).trim().optional(),
  rollNo: z.string().trim().optional(),
  houseColor: z.string().trim().optional(),
  bloodGroup: z.string().trim().optional(),
  religion: z.string().trim().optional(),
  category: z.string().trim().optional(),
  admissionDate: z.string().optional(),
  address: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  country: z.string().trim().optional(),
  guardians: z
    .array(
      z.object({
        name: z.string(),
        number: z.string(),
        relation: z.string(),
      })
    )
    .optional(),
});

const updateStudentSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  phone: z.string().max(20).trim().optional().nullable(),
  rollNo: z.string().trim().optional().nullable(),
  houseColor: z.string().trim().optional().nullable(),
  bloodGroup: z.string().trim().optional().nullable(),
  aadharNo: z.string().trim().optional().nullable(),
  panNo: z.string().trim().optional().nullable(),
  emergencyContact: z.string().trim().optional().nullable(),
  religion: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state: z.string().trim().optional().nullable(),
  pincode: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  guardians: z
    .array(
      z.object({
        name: z.string(),
        number: z.string(),
        relation: z.string(),
      })
    )
    .optional()
    .nullable(),
});
import { setPresence } from "../../services/presence.service";
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
import {
  taskUpload,
  generateQuestions,
  listQuestions,
  editQuestion,
  deleteQuestion,
  exportQuestions,
  listModules,
  createModule,
  editModule,
  deleteModule,
  assignQuestionToModule,
  unassignQuestionFromModule,
} from "./tasks.controller";

const router = Router();

const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware];

// ── Presence heartbeat ────────────────────────────────────────────────────────
router.post("/presence", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await setPresence(req.user!.userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Me ────────────────────────────────────────────────────────────────────────
router.get("/me", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    const user = await prisma.user.findFirst({
      where: { id: userId, institutionId },
      select: { id: true, name: true },
    });
    res.json({ success: true, data: { id: user?.id ?? userId, name: user?.name ?? "Teacher" } });
  } catch (err) {
    next(err);
  }
});

// ── Classes ───────────────────────────────────────────────────────────────────
router.get("/classes", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }

    const teacher = await prisma.teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    const assignments = await prisma.divisionAssignment.findMany({
      where: { teacherId: teacher.id, institutionId },
      include: {
        division: {
          include: {
            standard: true,
            _count: { select: { students: true } },
            assignments: {
              include: {
                teacher: { include: { user: { select: { id: true, name: true } } } },
                subject: true,
              },
            },
          },
        },
        subject: true,
      },
    });

    const classTeacher = assignments
      .filter((a) => a.subjectId === null)
      .map((a) => ({
        id: a.id,
        divisionId: a.divisionId,
        divisionName: a.division.name,
        standardName: a.division.standard.name,
        studentCount: a.division._count.students,
        subjects: a.division.assignments
          .filter((da) => da.subjectId !== null && da.subject !== null)
          .map((da) => ({
            id: da.subject!.id,
            name: da.subject!.name,
            color: da.subject!.color,
            teacherName: da.teacher.user.name,
          })),
      }));

    const subjectTeacher = assignments
      .filter((a) => a.subjectId !== null && a.subject !== null)
      .map((a) => ({
        id: a.id,
        divisionId: a.divisionId,
        divisionName: a.division.name,
        standardName: a.division.standard.name,
        subjectId: a.subject!.id,
        subjectName: a.subject!.name,
        subjectColor: a.subject!.color,
        studentCount: a.division._count.students,
      }));

    res.json({ success: true, data: { classTeacher, subjectTeacher } });
  } catch (err) {
    next(err);
  }
});

// ── Class Detail ─────────────────────────────────────────────────────────────
router.get("/classes/:divisionId", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution associated with this account" });
      return;
    }
    const divisionId = req.params.divisionId as string;

    const teacher = await prisma.teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    // Security gate — teacher must be assigned to this division
    const hasAssignment = await prisma.divisionAssignment.findFirst({
      where: { divisionId, teacherId: teacher.id, institutionId },
      select: { id: true },
    });
    if (!hasAssignment) {
      res.status(403).json({ success: false, error: "You are not assigned to this division" });
      return;
    }

    const division = await prisma.division.findFirst({
      where: { id: divisionId, institutionId },
      include: {
        standard: {
          include: { subjects: { orderBy: { order: "asc" } } },
        },
        divisionSubjects: { select: { subjectId: true } },
        assignments: {
          include: {
            teacher: { include: { user: { select: { id: true, name: true } } } },
            subject: true,
          },
        },
        _count: { select: { students: true } },
      },
    });
    if (!division) {
      res.status(404).json({ success: false, error: "Division not found" });
      return;
    }

    res.json({ success: true, data: division });
  } catch (err) {
    next(err);
  }
});

// ── Students — List ───────────────────────────────────────────────────────────
router.get(
  "/classes/:divisionId/students",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) {
        res.status(400).json({ success: false, error: "No institution" });
        return;
      }
      const divisionId = req.params.divisionId as string;

      const teacher = await prisma.teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const hasAssignment = await prisma.divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId },
        select: { id: true },
      });
      if (!hasAssignment) {
        res.status(403).json({ success: false, error: "Not assigned to this division" });
        return;
      }

      const students = await prisma.student.findMany({
        where: { divisionId, institutionId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              mustChangePassword: true,
            },
          },
        },
        orderBy: { joinedAt: "asc" },
      });

      res.json({ success: true, data: students });
    } catch (err) {
      next(err);
    }
  }
);

// ── Students — Create ─────────────────────────────────────────────────────────
router.post(
  "/classes/:divisionId/students",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) {
        res.status(400).json({ success: false, error: "No institution" });
        return;
      }
      const divisionId = req.params.divisionId as string;

      const teacher = await prisma.teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      // Only class teacher (subjectId = null) can add students
      const classAssignment = await prisma.divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) {
        res.status(403).json({ success: false, error: "Only class teacher can add students" });
        return;
      }

      const division = await prisma.division.findFirst({
        where: { id: divisionId, institutionId },
        select: { id: true, standardId: true },
      });
      if (!division) {
        res.status(404).json({ success: false, error: "Division not found" });
        return;
      }

      const data = addStudentSchema.parse(req.body);

      // Generate student ID
      const year = new Date().getFullYear();
      const count = await prisma.student.count({ where: { institutionId } });
      const studentId = `STU-${year}-${String(count + 1).padStart(4, "0")}`;

      // Generate and hash password
      const plainPassword = generateStudentPassword();
      const hashedPassword = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

      // Resolve email
      const email =
        data.email && data.email.length > 0
          ? data.email
          : `${studentId.toLowerCase().replace(/-/g, "")}@students.qubeex.local`;

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        res.status(400).json({ success: false, error: "A user with this email already exists" });
        return;
      }

      const student = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            name: data.name,
            email,
            password: hashedPassword,
            role: "STUDENT",
            institutionId,
            isActive: true,
            mustChangePassword: true,
          },
        });

        return tx.student.create({
          data: {
            studentId,
            userId: newUser.id,
            institutionId,
            standardId: division.standardId,
            divisionId,
            phone: data.phone,
            dob: data.dob,
            gender: data.gender,
            rollNo: data.rollNo,
            houseColor: data.houseColor,
            bloodGroup: data.bloodGroup,
            religion: data.religion,
            category: data.category,
            address: data.address,
            city: data.city,
            state: data.state,
            pincode: data.pincode,
            country: data.country ?? "India",
            guardians: data.guardians ?? undefined,
            tempPassword: plainPassword,
            joinedAt: data.admissionDate ? new Date(data.admissionDate) : new Date(),
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                mustChangePassword: true,
              },
            },
          },
        });
      });

      res.status(201).json({ success: true, data: { student, tempPassword: plainPassword } });
    } catch (err) {
      next(err);
    }
  }
);

// ── Students — Export (must be before :studentId route) ──────────────────────
router.get(
  "/classes/:divisionId/students/export",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) {
        res.status(400).json({ success: false, error: "No institution" });
        return;
      }
      const divisionId = req.params.divisionId as string;
      const format = (req.query.format as string) ?? "pdf";

      const teacher = await prisma.teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const hasAssignment = await prisma.divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!hasAssignment) {
        res.status(403).json({ success: false, error: "Not authorized" });
        return;
      }

      const division = await prisma.division.findFirst({
        where: { id: divisionId, institutionId },
        include: { standard: true },
      });

      const students = await prisma.student.findMany({
        where: { divisionId, institutionId },
        include: {
          user: { select: { name: true, email: true, mustChangePassword: true } },
        },
        orderBy: { joinedAt: "asc" },
      });

      const divisionLabel = division
        ? `${division.standard.name} - ${division.name}`
        : "Class";

      if (format === "csv") {
        const rows = [
          ["Roll No", "Name", "Student ID", "Email", "Initial Password", "Status"],
          ...students.map((s) => [
            s.rollNo ?? "",
            s.user.name ?? "",
            s.studentId,
            s.user.email,
            s.user.mustChangePassword && s.tempPassword ? s.tempPassword : "(changed)",
            s.status,
          ]),
        ];
        const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="students-${divisionId}.csv"`
        );
        res.send(csv);
        return;
      }

      // PDF export
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="students-${divisionId}.pdf"`
      );
      doc.pipe(res);

      // Title
      doc.fontSize(18).font("Helvetica-Bold").text("Student Credentials", { align: "center" });
      doc.fontSize(11).font("Helvetica").fillColor("#666").text(divisionLabel, { align: "center" });
      doc.moveDown(1.2);

      // Table header
      const colX = [40, 90, 200, 310, 430, 510];
      const rowH = 22;
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#000");
      doc.rect(40, doc.y, 520, rowH).fill("#f0f0f0");
      const headerY = doc.y + 6;
      ["Roll", "Name", "Student ID", "Email", "Password", "Status"].forEach((h, i) => {
        doc.fillColor("#000").text(h, colX[i], headerY, { width: colX[i + 1] - colX[i] - 4 });
      });
      doc.moveDown(0.15);
      doc.moveTo(40, doc.y + rowH - 14).lineTo(560, doc.y + rowH - 14).stroke();
      doc.moveDown(0.5);

      // Rows
      doc.font("Helvetica").fontSize(8);
      students.forEach((s, idx) => {
        if (doc.y > 760) {
          doc.addPage();
          doc.moveDown(0.5);
        }
        const y = doc.y + 3;
        const bg = idx % 2 === 0 ? "#ffffff" : "#fafafa";
        doc.rect(40, doc.y, 520, rowH - 2).fill(bg);
        const password =
          s.user.mustChangePassword && s.tempPassword ? s.tempPassword : "(changed)";
        [
          s.rollNo ?? "—",
          s.user.name ?? "—",
          s.studentId,
          s.user.email,
          password,
          s.status,
        ].forEach((val, i) => {
          doc.fillColor("#000").text(val, colX[i], y, {
            width: colX[i + 1] ? colX[i + 1] - colX[i] - 4 : 60,
            ellipsis: true,
          });
        });
        doc.moveDown(0.55);
      });

      doc.end();
    } catch (err) {
      next(err);
    }
  }
);

// ── Students — Update ─────────────────────────────────────────────────────────
router.patch(
  "/classes/:divisionId/students/:studentId",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) {
        res.status(400).json({ success: false, error: "No institution" });
        return;
      }
      const divisionId = req.params.divisionId as string;
      const studentId = req.params.studentId as string;

      const teacher = await prisma.teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const classAssignment = await prisma.divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) {
        res.status(403).json({ success: false, error: "Only class teacher can update students" });
        return;
      }

      const student = await prisma.student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true, userId: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found" });
        return;
      }

      const data = updateStudentSchema.parse(req.body);
      const { name, guardians, ...studentFields } = data;

      await prisma.$transaction(async (tx) => {
        if (name) {
          await tx.user.update({ where: { id: student.userId }, data: { name } });
        }
        await tx.student.update({
          where: { id: student.id },
          data: {
            ...studentFields,
            ...(guardians !== undefined
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? { guardians: guardians === null ? null : (guardians as any) }
              : {}),
          },
        });
      });

      const updated = await prisma.student.findFirst({
        where: { id: studentId as string },
        include: {
          user: {
            select: { id: true, name: true, email: true, mustChangePassword: true },
          },
        },
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ── Students — Toggle Status ──────────────────────────────────────────────────
router.patch(
  "/classes/:divisionId/students/:studentId/status",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) {
        res.status(400).json({ success: false, error: "No institution" });
        return;
      }
      const divisionId = req.params.divisionId as string;
      const studentId = req.params.studentId as string;
      const { status } = req.body as { status: "ACTIVE" | "INACTIVE" };

      if (!["ACTIVE", "INACTIVE"].includes(status)) {
        res.status(400).json({ success: false, error: "Invalid status" });
        return;
      }

      const teacher = await prisma.teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const classAssignment = await prisma.divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) {
        res.status(403).json({ success: false, error: "Only class teacher can update students" });
        return;
      }

      const student = await prisma.student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true, userId: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found" });
        return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.student.update({ where: { id: student.id }, data: { status } });
        await tx.user.update({
          where: { id: student.userId },
          data: { isActive: status === "ACTIVE" },
        });
      });

      res.json({ success: true, data: { status } });
    } catch (err) {
      next(err);
    }
  }
);

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

// ── Tasks — Question Generation ───────────────────────────────────────────────
router.post("/tasks/generate", ...T, taskUpload.single("file"), generateQuestions);
router.get("/tasks/questions", ...T, listQuestions);
router.patch("/tasks/questions/:id", ...T, editQuestion);
router.delete("/tasks/questions/:id", ...T, deleteQuestion);
router.get("/tasks/questions/export", ...T, exportQuestions);

// ── Tasks — Modules ───────────────────────────────────────────────────────────
router.get("/tasks/modules", ...T, listModules);
router.post("/tasks/modules", ...T, createModule);
router.patch("/tasks/modules/:id", ...T, editModule);
router.delete("/tasks/modules/:id", ...T, deleteModule);

// ── Tasks — Module-Question Assignment ────────────────────────────────────────
router.post("/tasks/modules/:id/questions", ...T, assignQuestionToModule);
router.delete("/tasks/modules/:id/questions/:qid", ...T, unassignQuestionFromModule);

export default router;
