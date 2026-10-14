import teacherInventoryRequests from "../inventory/item-requests.routes";
import { Router, Response, NextFunction } from "express";
import { authMiddleware, AuthRequest } from "../../middlewares/auth.middleware";
import { institutionAccessMiddleware } from "../../middlewares/institutionAccess.middleware";
import { academicRoutingMiddleware } from "../../middlewares/academicRouting.middleware";
import { prisma } from "../../utils/prisma";
import { academicDb } from "../../utils/academicContext";
import { resolveUsers } from "../../services/userLookup.service";
import { generateUserId } from "../../utils/userId";
import bcrypt from "bcrypt";
import PDFDocument from "pdfkit";
import { z } from "zod";
import multer from "multer";
import { uploadImageToR2, generateSignedAvatarUrl, generateSignedAvatarUrlsBatch } from "../../services/storage.service";
import { logAudit } from "../../services/audit.service";
import { createRemarkSchema, reviewRemarkSchema, editRemarkSchema } from "../../services/remark.schema";
import { createStudentRemark, listStudentRemarks, listAssignedRemarks, listSubmittedRemarks, reviewStudentRemark, editStudentRemark } from "../../services/remark.service";
import { createPTMNote, listPTMNotes, editPTMNote } from "../../services/ptmNote.service";
import { getDivisionLeaderboardData } from "../../services/leaderboard.service";
import { getStudentStatsData } from "../../services/studentStats.service";
import { getStudentMarksheetData } from "../../services/studentMarksheet.service";
import { getStudentAttendanceTrendData } from "../../services/studentAttendanceTrend.service";
import { getStudentAttendanceDetailData } from "../../services/studentAttendanceDetail.service";
import { recordUserStatusEvent } from "../../services/userStatusEvent.service";
import { delCache } from "../../utils/cache";
import { getCurrentAcademicYear, upsertCurrentEnrollment, resolveRequestedAcademicYear } from "../../utils/academicYear";

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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
  email: z.string().email().trim().optional(),
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
  nationality: z.string().trim().optional().nullable(),
  admissionYear: z.string().trim().optional().nullable(),
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
import { buildStudentPIIUpdate, decryptStudentPII } from "../../services/fieldEncryption.service";
import {
  upload,
  listFolders,
  createFolder,
  deleteFolder,
  uploadFile,
  deleteFile,
  normalizePdfUpload,
  aiScan,
  aiChat,
  aiQuiz,
  aiMindmap,
  aiMagic,
  listMindmaps,
  getMindmap,
  deleteMindmap,
  searchImages,
} from "./blackboard.controller";
import {
  taskUpload,
  taskImageUpload,
  addQuestionImages,
  removeQuestionImage,
  generateQuestions,
  listUploads,
  getUploadStatus,
  listQuestions,
  createManualQuestion,
  createShareToken,
  getSharedQuestions,
  importSharedQuestions,
  updateQuestionStatus,
  editQuestion,
  deleteQuestion,
  exportQuestions,
  listTests,
  createTest,
  getTest,
  updateTest,
  deleteTest,
  addTestQuestion,
  removeTestQuestion,
  getTestResults,
  downloadTestResults,
  downloadAttemptPdfForTeacher,
  savePaper,
  listModules,
  createModule,
  editModule,
  reorderModules,
  deleteModule,
  assignQuestionToModule,
  unassignQuestionFromModule,
  reorderModuleQuestions,
  createModuleQuestion,
  listAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getAssignment,
  getInstitutionLetterhead,
  saveAssignmentPaper,
  getAssignmentSubmissions,
  reviewSubmission,
  markOfflineSubmission,
  markOfflineLate,
  listContainers,
  createContainer,
  renameContainer,
  deleteContainer,
} from "./tasks.controller";
import {
  initMarksheet, getDivisionMarksheet, getDivisionOnlineMarksheet,
  addColumn, editColumn, deleteColumn, reorderColumns,
  setSubjectConfig, bulkUpsertScores,
  addGradedSubject, editGradedSubject, deleteGradedSubject,
  reorderGradedSubjects, updateGradedSectionTitle, bulkUpsertGradedScores,
  publishMarksheet, downloadMarksheet, updateMarksheetGradeScale,
  upsertMarksheetRemark,
} from "./marksheet.controller";
import {
  getNotepad,
  createNote,
  updateNote,
  deleteNote,
  createTask,
  updateTask,
  deleteTask,
} from "./notepad.controller";
import { getOverview, getMyAiUsage } from "./overview.controller";
import { listMyPayslips, redirectToMyPayslipPdf, getMyAttendance } from "./payroll.controller";
import { getProfile, updateProfile, changePassword, getLoginActivity } from "../shared/profile.controller";
import { listMyAuditLogs } from "./audit.controller";
import {
  listNotifications,
  markNotificationRead,
  dismissNotification,
  markAllNotificationsRead,
} from "../admin/notifications.controller";
import { registerDevicePushToken, unregisterDevicePushToken } from "../admin/pushToken.controller";

const router = Router();

const T = [authMiddleware(["TEACHER"]), institutionAccessMiddleware, academicRoutingMiddleware];

// Same inventory request workflow, with teacher-only authentication and ownership.
router.use("/inventory", ...T, teacherInventoryRequests);

// ── Account settings (profile / password / login activity) ────────────────────
router.get("/profile", ...T, getProfile);
router.put("/profile", ...T, updateProfile);
router.put("/profile/password", ...T, changePassword);
router.get("/profile/login-activity", ...T, getLoginActivity);

// ── Audit logs (this teacher's own activity only) ─────────────────────────────
router.get("/audit-logs", ...T, listMyAuditLogs);

// ── Presence heartbeat ────────────────────────────────────────────────────────
router.post("/presence", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await setPresence(req.user!.userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Overview ──────────────────────────────────────────────────────────────────
router.get("/overview", ...T, getOverview);
router.get("/ai-usage", ...T, getMyAiUsage);
router.get("/payroll/payslips", ...T, listMyPayslips);
router.get("/payroll/payslips/:id/pdf", ...T, redirectToMyPayslipPdf);
router.get("/payroll/attendance", ...T, getMyAttendance);

// ── Notifications ─────────────────────────────────────────────────────────────
router.get("/notifications", ...T, listNotifications);
router.patch("/notifications/read-all", ...T, markAllNotificationsRead);
router.patch("/notifications/:recipientId/read", ...T, markNotificationRead);
router.patch("/notifications/:recipientId/dismiss", ...T, dismissNotification);
router.post("/push-token", ...T, registerDevicePushToken);
router.delete("/push-token", ...T, unregisterDevicePushToken);

// ── Me ────────────────────────────────────────────────────────────────────────
router.get("/me", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;

    const meYear = await getCurrentAcademicYear(institutionId!);
    const teacher = await academicDb().teacher.findFirst({
      where: { userId, institutionId },
      include: {
        assignments: {
          where: { academicYearId: meYear.id },
          include: {
            division: { include: { standard: true } },
            subject: { select: { id: true, name: true, color: true } },
          },
        },
      },
    });

    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    const meUserMap = await resolveUsers([teacher.userId], { id: true, name: true, email: true });

    let avatarUrl: string | null = teacher.avatarUrl;
    if (avatarUrl) {
      const signed = await generateSignedAvatarUrl(avatarUrl);
      if (signed) avatarUrl = signed;
    }

    res.json({ success: true, data: { ...teacher, user: meUserMap.get(teacher.userId) ?? null, avatarUrl } });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /teacher/me ────────────────────────────────────────────────────────
const updateProfileSchema = z.object({
  name:          z.string().min(1).max(100).trim().optional(),
  phone:         z.string().max(20).trim().optional().nullable(),
  dob:           z.string().trim().optional().nullable(),
  gender:        z.enum(["MALE", "FEMALE", "OTHER"]).optional().nullable(),
  address:       z.string().trim().optional().nullable(),
  city:          z.string().trim().optional().nullable(),
  state:         z.string().trim().optional().nullable(),
  pincode:       z.string().trim().optional().nullable(),
  country:       z.string().trim().optional().nullable(),
  qualification: z.string().trim().optional().nullable(),
  experience:    z.string().trim().optional().nullable(),
  prefix:        z.string().trim().optional().nullable(),
  title:         z.string().trim().optional().nullable(),
});

router.patch("/me", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    const data = updateProfileSchema.parse(req.body);

    const teacher = await academicDb().teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    const { name, ...teacherFields } = data;
    const teacherUpdate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(teacherFields)) {
      if (v !== undefined) teacherUpdate[k] = v;
    }

    // User (central) and Teacher (may be tenant, for BYOD) can live in two
    // different databases, so a single transaction can't span both.
    const acad = academicDb();
    if (acad === prisma) {
      await prisma.$transaction([
        ...(name ? [prisma.user.update({ where: { id: userId }, data: { name } })] : []),
        ...(Object.keys(teacherUpdate).length > 0 ? [acad.teacher.update({ where: { id: teacher.id }, data: teacherUpdate })] : []),
      ]);
    } else {
      if (name) await prisma.user.update({ where: { id: userId }, data: { name } });
      if (Object.keys(teacherUpdate).length > 0)
        await acad.teacher.update({ where: { id: teacher.id }, data: teacherUpdate });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /teacher/photo ───────────────────────────────────────────────────────
// Multer must run before academicRoutingMiddleware — busboy's internal stream
// events (Multipart 'close'/nextTick) aren't reliably tracked as children of the
// AsyncLocalStorage scope academicRoutingMiddleware opens, so a route handler
// downstream of `...T` sees "No academic client in context" if multer parses
// the body afterwards. Parsing the file first avoids crossing that boundary.
router.post("/photo", authMiddleware(["TEACHER"]), institutionAccessMiddleware, photoUpload.single("photo"), academicRoutingMiddleware, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!req.file) {
      res.status(400).json({ success: false, error: "No photo file provided" });
      return;
    }

    const teacher = await academicDb().teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    const { publicUrl } = await uploadImageToR2(req.file.buffer, {
      contentType: req.file.mimetype,
      folder: "teacher-photos",
      ownerId: teacher.id,
    });

    await academicDb().teacher.update({
      where: { id: teacher.id },
      data: { avatarUrl: publicUrl },
    });

    const signedUrl = (await generateSignedAvatarUrl(publicUrl)) ?? publicUrl;
    res.json({ success: true, data: { avatarUrl: signedUrl } });
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

    const teacher = await academicDb().teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    // Only the current year's assignments: past years' rows are history and
    // would otherwise list the same division once per year.
    const listYear = await getCurrentAcademicYear(institutionId);
    const assignments = await academicDb().divisionAssignment.findMany({
      where: { teacherId: teacher.id, institutionId, academicYearId: listYear.id },
      include: {
        division: {
          include: {
            standard: true,
            _count: { select: { students: { where: { status: "ACTIVE" } } } },
            assignments: {
              where: { academicYearId: listYear.id },
              include: {
                teacher: true,
                subject: true,
              },
              orderBy: { subject: { order: "asc" } },
            },
          },
        },
        subject: true,
      },
      orderBy: { subject: { order: "asc" } },
    });

    const classListTeacherUserMap = await resolveUsers(
      assignments.flatMap((a) => a.division.assignments.map((da) => da.teacher.userId)),
      { id: true, name: true }
    );

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
            teacherName: classListTeacherUserMap.get(da.teacher.userId)?.name ?? "Unknown",
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
        createdAt: a.createdAt.toISOString(),
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

    const teacher = await academicDb().teacher.findFirst({
      where: { userId, institutionId },
      select: { id: true },
    });
    if (!teacher) {
      res.status(404).json({ success: false, error: "Teacher profile not found" });
      return;
    }

    // Security gate — teacher must be assigned to this division
    const hasAssignment = await academicDb().divisionAssignment.findFirst({
      where: { divisionId, teacherId: teacher.id, institutionId },
      select: { id: true },
    });
    if (!hasAssignment) {
      res.status(403).json({ success: false, error: "You are not assigned to this division" });
      return;
    }

    const detailYear = await getCurrentAcademicYear(institutionId);
    const division = await academicDb().division.findFirst({
      where: { id: divisionId, institutionId },
      include: {
        standard: {
          include: { subjects: { orderBy: { order: "asc" } } },
        },
        divisionSubjects: { select: { subjectId: true } },
        assignments: {
          where: { academicYearId: detailYear.id },
          include: {
            teacher: true,
            subject: true,
          },
        },
        _count: { select: { students: { where: { status: "ACTIVE" } } } },
      },
    });
    if (!division) {
      res.status(404).json({ success: false, error: "Division not found" });
      return;
    }

    const detailTeacherUserMap = await resolveUsers(division.assignments.map((a) => a.teacher.userId), { id: true, name: true });
    const rawTeacherAvatarUrls = division.assignments.map((a) => a.teacher.avatarUrl);
    const signedTeacherAvatarMap = await generateSignedAvatarUrlsBatch(rawTeacherAvatarUrls);
    const assignmentsWithAvatars = division.assignments.map((a) => ({
      ...a,
      teacher: {
        ...a.teacher,
        user: detailTeacherUserMap.get(a.teacher.userId) ?? null,
        avatarUrl: a.teacher.avatarUrl ? (signedTeacherAvatarMap[a.teacher.avatarUrl] ?? a.teacher.avatarUrl) : null,
      },
    }));

    res.json({ success: true, data: { ...division, assignments: assignmentsWithAvatars } });
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

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const [assignment, division] = await Promise.all([
        academicDb().divisionAssignment.findFirst({
          where: { divisionId, teacherId: teacher.id, institutionId },
          select: { id: true },
        }),
        academicDb().division.findFirst({
          where: { id: divisionId, institutionId },
          select: { classTeacherId: true },
        }),
      ]);
      const isClassTeacher = division?.classTeacherId === teacher.id;
      if (!assignment && !isClassTeacher) {
        res.status(403).json({ success: false, error: "Not assigned to this division" });
        return;
      }

      const year = await resolveRequestedAcademicYear(
        req.query.academicYearId as string | undefined,
        institutionId,
        { role: req.user!.role, userId: req.user!.userId }
      );

      let students;
      if (year.isCurrent) {
        students = await academicDb().student.findMany({
          where: { divisionId, institutionId },
          orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
        });
      } else {
        const enrollments = await academicDb().studentEnrollment.findMany({
          where: { divisionId, academicYearId: year.id, institutionId },
          orderBy: [{ rollNo: "asc" }, { student: { joinedAt: "asc" } }],
          include: { student: true },
        });
        students = enrollments.map((e) => ({
          ...e.student,
          rollNo: e.rollNo ?? e.student.rollNo,
          status: e.status,
          divisionId: e.divisionId,
          standardId: e.standardId,
        }));
      }
      const listStudentUserMap = await resolveUsers(students.map((s) => s.userId), {
        id: true,
        name: true,
        email: true,
        mustChangePassword: true,
      });

      // Sign all avatar URLs in one batch call
      const signedMap = await generateSignedAvatarUrlsBatch(students.map(s => s.avatarUrl));
      const data = students.map(s => ({
        ...s,
        ...decryptStudentPII(s),
        user: listStudentUserMap.get(s.userId) ?? null,
        avatarUrl: s.avatarUrl ? (signedMap[s.avatarUrl] ?? s.avatarUrl) : null,
      }));

      res.json({ success: true, data });
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

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      // Only class teacher (subjectId = null) can add students
      const classAssignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) {
        res.status(403).json({ success: false, error: "Only class teacher can add students" });
        return;
      }

      const division = await academicDb().division.findFirst({
        where: { id: divisionId, institutionId },
        select: { id: true, standardId: true, name: true, standard: { select: { name: true } } },
      });
      if (!division) {
        res.status(404).json({ success: false, error: "Division not found" });
        return;
      }

      const data = addStudentSchema.parse(req.body);

      if (data.rollNo && data.rollNo.trim()) {
        const rollNoConflict = await academicDb().student.findFirst({
          where: {
            divisionId,
            institutionId,
            rollNo: data.rollNo.trim(),
            status: { notIn: ["WITHDRAWN", "GRADUATED"] },
          },
          select: { id: true },
        });
        if (rollNoConflict) {
          res.status(400).json({ success: false, error: `Roll No ${data.rollNo.trim()} is already assigned to another student in this class` });
          return;
        }
      }

      const studentId = await generateUserId(institutionId, "S");

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

      // User (central) is always required before Student can reference its userId;
      // Student itself may live in the tenant DB (BYOD), so the two creates can't
      // share one transaction across databases. Managed institutions still get a
      // single atomic transaction since academicDb() === prisma there.
      // Encrypted at rest — phone, address, city, pincode, and guardians[].number
      // never get stored in plaintext.
      const piiCreate = buildStudentPIIUpdate({
        phone: data.phone,
        address: data.address,
        city: data.city,
        pincode: data.pincode,
        guardians: data.guardians,
      });

      const studentCreateData = (newUserId: string) => ({
        studentId,
        userId: newUserId,
        institutionId,
        standardId: division.standardId,
        divisionId,
        dob: data.dob,
        gender: data.gender,
        rollNo: data.rollNo,
        houseColor: data.houseColor,
        bloodGroup: data.bloodGroup,
        religion: data.religion,
        category: data.category,
        state: data.state,
        country: data.country ?? "India",
        tempPassword: plainPassword,
        joinedAt: data.admissionDate ? new Date(data.admissionDate) : new Date(),
        ...piiCreate,
      });

      const acad = academicDb();
      let student;
      if (acad === prisma) {
        student = await prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: { name: data.name, email, password: hashedPassword, role: "STUDENT", institutionId, isActive: true, mustChangePassword: true },
          });
          await recordUserStatusEvent(tx, { userId: newUser.id, institutionId, isActive: true });
          const created = await tx.student.create({ data: studentCreateData(newUser.id) });
          await upsertCurrentEnrollment(institutionId, {
            studentId: created.id,
            standardId: division.standardId,
            divisionId,
            status: "ACTIVE",
          }, tx);
          return created;
        });
      } else {
        const newUser = await prisma.$transaction(async (tx) => {
          const u = await tx.user.create({
            data: { name: data.name, email, password: hashedPassword, role: "STUDENT", institutionId, isActive: true, mustChangePassword: true },
          });
          await recordUserStatusEvent(tx, { userId: u.id, institutionId, isActive: true });
          return u;
        });
        student = await acad.student.create({ data: studentCreateData(newUser.id) });
        await upsertCurrentEnrollment(institutionId, {
          studentId: student.id,
          standardId: division.standardId,
          divisionId,
          status: "ACTIVE",
        }, acad);
      }
      const createdStudentUserMap = await resolveUsers([student.userId], { id: true, name: true, email: true, mustChangePassword: true });
      student = { ...student, ...decryptStudentPII(student), user: createdStudentUserMap.get(student.userId) ?? null };

      logAudit("STUDENT_ADDED", {
        userId,
        actorRole: "TEACHER",
        institutionId,
        details: `Added student ${data.name} to ${division.standard.name} - ${division.name}`,
        metadata: { studentId: student.studentId, email: createdStudentUserMap.get(student.userId)?.email },
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

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const hasAssignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!hasAssignment) {
        res.status(403).json({ success: false, error: "Not authorized" });
        return;
      }

      const division = await academicDb().division.findFirst({
        where: { id: divisionId, institutionId },
        include: { standard: true },
      });

      const exportStudentsRaw = await academicDb().student.findMany({
        where: { divisionId, institutionId },
        orderBy: { joinedAt: "asc" },
      });
      const exportUserMap = await resolveUsers(exportStudentsRaw.map((s) => s.userId), {
        id: true,
        name: true,
        email: true,
        mustChangePassword: true,
      });
      const students = exportStudentsRaw.map((s) => ({
        ...s,
        user: exportUserMap.get(s.userId) ?? { id: s.userId, name: null, email: "", mustChangePassword: false },
      }));

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

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const classAssignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) {
        res.status(403).json({ success: false, error: "Only class teacher can update students" });
        return;
      }

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true, userId: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found" });
        return;
      }

      const data = updateStudentSchema.parse(req.body);
      const { name, email, guardians, aadharNo, phone, address, city, pincode, panNo, emergencyContact, ...studentFields } = data;
      // Encrypted at rest — phone, address, city, pincode, aadharNo, panNo,
      // emergencyContact, and guardians[].number never get stored in plaintext.
      const piiUpdate = buildStudentPIIUpdate({ phone, address, city, pincode, aadharNo, panNo, emergencyContact, guardians });

      if (data.rollNo && data.rollNo.trim()) {
        const rollNoConflict = await academicDb().student.findFirst({
          where: {
            divisionId,
            institutionId,
            rollNo: data.rollNo.trim(),
            status: { notIn: ["WITHDRAWN", "GRADUATED"] },
            id: { not: student.id },
          },
          select: { id: true },
        });
        if (rollNoConflict) {
          res.status(400).json({ success: false, error: `Roll No ${data.rollNo.trim()} is already assigned to another student in this class` });
          return;
        }
      }

      if (email) {
        const emailConflict = await prisma.user.findFirst({
          where: { email, id: { not: student.userId } },
          select: { id: true },
        });
        if (emailConflict) {
          res.status(400).json({ success: false, error: "A user with this email already exists" });
          return;
        }
      }

      const studentUpdateData = {
        ...studentFields,
        ...piiUpdate,
      };
      const acadUpd = academicDb();
      if (acadUpd === prisma) {
        await prisma.$transaction([
          ...(name || email ? [prisma.user.update({ where: { id: student.userId }, data: { ...(name && { name }), ...(email && { email }) } })] : []),
          acadUpd.student.update({ where: { id: student.id }, data: studentUpdateData }),
        ]);
      } else {
        if (name || email) {
          await prisma.user.update({ where: { id: student.userId }, data: { ...(name && { name }), ...(email && { email }) } });
        }
        await acadUpd.student.update({ where: { id: student.id }, data: studentUpdateData });
      }

      const updatedRow = await academicDb().student.findFirst({ where: { id: studentId as string } });
      const updatedUserMap = updatedRow ? await resolveUsers([updatedRow.userId], { id: true, name: true, email: true, mustChangePassword: true }) : new Map();
      const updated = updatedRow
        ? { ...updatedRow, ...decryptStudentPII(updatedRow), user: updatedUserMap.get(updatedRow.userId) ?? null }
        : null;

      logAudit("STUDENT_UPDATED", {
        userId,
        actorRole: "TEACHER",
        institutionId,
        details: `Updated student ${updated?.user?.name ?? studentId}`,
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

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const classAssignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) {
        res.status(403).json({ success: false, error: "Only class teacher can update students" });
        return;
      }

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true, userId: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found" });
        return;
      }

      const acadStatus = academicDb();
      if (acadStatus === prisma) {
        await prisma.$transaction(async (tx) => {
          await tx.student.update({ where: { id: student.id }, data: { status } });
          await tx.user.update({ where: { id: student.userId }, data: { isActive: status === "ACTIVE" } });
          await recordUserStatusEvent(tx, { userId: student.userId, institutionId, isActive: status === "ACTIVE" });
        });
      } else {
        await acadStatus.student.update({ where: { id: student.id }, data: { status } });
        await prisma.$transaction(async (tx) => {
          await tx.user.update({ where: { id: student.userId }, data: { isActive: status === "ACTIVE" } });
          await recordUserStatusEvent(tx, { userId: student.userId, institutionId, isActive: status === "ACTIVE" });
        });
      }

      const statusUser = await prisma.user.findUnique({ where: { id: student.userId }, select: { name: true } });
      logAudit(status === "ACTIVE" ? "STUDENT_ACTIVATED" : "STUDENT_DEACTIVATED", {
        userId,
        actorRole: "TEACHER",
        institutionId,
        details: `${status === "ACTIVE" ? "Activated" : "Deactivated"} student ${statusUser?.name ?? studentId}`,
      });

      res.json({ success: true, data: { status } });
    } catch (err) {
      next(err);
    }
  }
);

// ── Students — Reset Password (class teacher only) ────────────────────────────
router.post(
  "/classes/:divisionId/students/:studentId/reset-password",
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

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const classAssignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) {
        res.status(403).json({ success: false, error: "Only class teacher can reset student passwords" });
        return;
      }

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true, userId: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found" });
        return;
      }

      const plainPassword = generateStudentPassword();
      const hashedPassword = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

      const acadReset = academicDb();
      if (acadReset === prisma) {
        await prisma.$transaction([
          prisma.user.update({ where: { id: student.userId }, data: { password: hashedPassword, mustChangePassword: true } }),
          acadReset.student.update({ where: { id: student.id }, data: { tempPassword: plainPassword } }),
        ]);
      } else {
        await prisma.user.update({ where: { id: student.userId }, data: { password: hashedPassword, mustChangePassword: true } });
        await acadReset.student.update({ where: { id: student.id }, data: { tempPassword: plainPassword } });
      }

      res.json({ success: true, data: { newTempPassword: plainPassword } });
    } catch (err) {
      next(err);
    }
  }
);

// ── Blackboard Storage ────────────────────────────────────────────────────────
router.get("/blackboard/storage/folders", ...T, listFolders);
router.post("/blackboard/storage/folders", ...T, createFolder);
router.delete("/blackboard/storage/folders/:id", ...T, deleteFolder);
router.post("/blackboard/storage/folders/:id/files", authMiddleware(["TEACHER"]), institutionAccessMiddleware, upload.single("file"), academicRoutingMiddleware, uploadFile);
router.delete("/blackboard/storage/files/:id", ...T, deleteFile);
// Stateless "clean this PDF for me" pass-through for the client-side
// "From Computer" load flow, which never otherwise touches the backend —
// no folder/DB involved, just auth + normalize + return bytes.
router.post("/blackboard/normalize-pdf", authMiddleware(["TEACHER"]), upload.single("file"), normalizePdfUpload);

// ── Blackboard AI ─────────────────────────────────────────────────────────────
router.post("/blackboard/ai/scan", ...T, aiScan);
router.post("/blackboard/ai/chat", ...T, aiChat);
router.post("/blackboard/ai/quiz", ...T, aiQuiz);
router.post("/blackboard/ai/mindmap", ...T, aiMindmap);
router.post("/blackboard/ai/magic", ...T, aiMagic);
router.get("/blackboard/mindmaps", ...T, listMindmaps);
router.get("/blackboard/mindmaps/:id", ...T, getMindmap);
router.delete("/blackboard/mindmaps/:id", ...T, deleteMindmap);

// ── Blackboard Images ─────────────────────────────────────────────────────────
router.get("/blackboard/images", ...T, searchImages);

// ── Tasks — PDF Generation ────────────────────────────────────────────────────
router.post("/tasks/generate", authMiddleware(["TEACHER"]), institutionAccessMiddleware, taskUpload.single("file"), academicRoutingMiddleware, generateQuestions);
router.get("/tasks/uploads", ...T, listUploads);
router.get("/tasks/uploads/:id", ...T, getUploadStatus);

// ── Tasks — Containers ────────────────────────────────────────────────────────
router.get("/tasks/containers", ...T, listContainers);
router.post("/tasks/containers", ...T, createContainer);
router.patch("/tasks/containers/:id", ...T, renameContainer);
router.delete("/tasks/containers/:id", ...T, deleteContainer);

// ── Tasks — Question Bank ─────────────────────────────────────────────────────
router.get("/tasks/questions", ...T, listQuestions);
router.post("/tasks/questions", ...T, createManualQuestion);
router.post("/tasks/questions/share", ...T, createShareToken);
router.get("/tasks/questions/share/:token", ...T, getSharedQuestions);
router.post("/tasks/questions/import", ...T, importSharedQuestions);
router.patch("/tasks/questions/:id/status", ...T, updateQuestionStatus);
router.patch("/tasks/questions/:id", ...T, editQuestion);
router.delete("/tasks/questions/:id", ...T, deleteQuestion);
router.get("/tasks/questions/export", ...T, exportQuestions);
// Multer must run before academicRoutingMiddleware — same reason as /tasks/generate above.
router.post(
  "/tasks/questions/:id/images",
  authMiddleware(["TEACHER"]),
  institutionAccessMiddleware,
  taskImageUpload.array("images", 6),
  academicRoutingMiddleware,
  addQuestionImages
);
router.delete("/tasks/questions/:id/images", ...T, removeQuestionImage);

// ── Tasks — Tests ─────────────────────────────────────────────────────────────
router.get("/tasks/tests", ...T, listTests);
router.post("/tasks/tests", ...T, createTest);
router.get("/tasks/tests/:id", ...T, getTest);
router.patch("/tasks/tests/:id", ...T, updateTest);
router.delete("/tasks/tests/:id", ...T, deleteTest);
router.put("/tasks/tests/:id/paper", ...T, savePaper);
router.post("/tasks/tests/:id/questions", ...T, addTestQuestion);
router.delete("/tasks/tests/:id/questions/:qid", ...T, removeTestQuestion);
router.get("/tasks/tests/:id/results", ...T, getTestResults);
router.get("/tasks/tests/:id/results/download", ...T, downloadTestResults);
router.get("/tasks/attempts/:id/pdf", ...T, downloadAttemptPdfForTeacher);

// ── Tasks — Assignments ───────────────────────────────────────────────────────
router.get("/tasks/assignments", ...T, listAssignments);
router.post("/tasks/assignments", ...T, createAssignment);
router.get("/tasks/assignments/:id", ...T, getAssignment);
router.patch("/tasks/assignments/:id", ...T, updateAssignment);
router.delete("/tasks/assignments/:id", ...T, deleteAssignment);
router.put("/tasks/assignments/:id/paper", ...T, saveAssignmentPaper);
router.get("/tasks/assignments/:id/submissions", ...T, getAssignmentSubmissions);
router.patch("/tasks/assignments/:id/submissions/:studentId/review", ...T, reviewSubmission);
router.patch("/tasks/assignments/:id/submissions/:studentId/offline", ...T, markOfflineSubmission);
router.patch("/tasks/assignments/:id/submissions/:studentId/offline-late", ...T, markOfflineLate);
router.get("/institution/letterhead", ...T, getInstitutionLetterhead);

// ── Tasks — Modules ───────────────────────────────────────────────────────────
router.get("/tasks/modules", ...T, listModules);
router.post("/tasks/modules", ...T, createModule);
router.patch("/tasks/modules/reorder", ...T, reorderModules);
router.patch("/tasks/modules/:id", ...T, editModule);
router.delete("/tasks/modules/:id", ...T, deleteModule);

// ── Tasks — Module-Question Assignment ────────────────────────────────────────
router.post("/tasks/modules/:id/questions", ...T, assignQuestionToModule);
router.post("/tasks/modules/:id/questions/manual", ...T, createModuleQuestion);
router.patch("/tasks/modules/:id/questions/reorder", ...T, reorderModuleQuestions);
router.delete("/tasks/modules/:id/questions/:qid", ...T, unassignQuestionFromModule);

// ─────────────────────────────────────────────────────────────────────────────
// ── Attendance ────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Helper: verify teacher is assigned to division (any role — class or subject)
async function assertDivisionAccess(
  userId: string,
  institutionId: string,
  divisionId: string
): Promise<string> {
  const teacher = await academicDb().teacher.findFirst({
    where: { userId, institutionId },
    select: { id: true },
  });
  if (!teacher) throw { status: 404, message: "Teacher profile not found" };

  const assignment = await academicDb().divisionAssignment.findFirst({
    where: { divisionId, teacherId: teacher.id, institutionId },
    select: { id: true },
  });
  if (!assignment) throw { status: 403, message: "Not assigned to this division" };

  return teacher.id;
}

// Helper: verify teacher is CLASS teacher (subjectId = null)
async function assertClassTeacher(
  userId: string,
  institutionId: string,
  divisionId: string
): Promise<string> {
  const teacher = await academicDb().teacher.findFirst({
    where: { userId, institutionId },
    select: { id: true },
  });
  if (!teacher) throw { status: 404, message: "Teacher profile not found" };

  const assignment = await academicDb().divisionAssignment.findFirst({
    where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
    select: { id: true },
  });
  if (!assignment) throw { status: 403, message: "Only class teacher can perform this action" };

  return teacher.id;
}

// ── GET /attendance/:divisionId/holidays ──────────────────────────────────────
router.get(
  "/attendance/:divisionId/holidays",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      await assertDivisionAccess(userId, institutionId, divisionId);

      const holidays = await academicDb().schoolHoliday.findMany({
        where: { institutionId },
        select: { date: true, name: true },
        orderBy: { date: "asc" },
      });
      res.json({ success: true, data: holidays });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
      next(err);
    }
  }
);

// ── POST /attendance/:divisionId/holidays ─────────────────────────────────────
router.post(
  "/attendance/:divisionId/holidays",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      await assertClassTeacher(userId, institutionId, divisionId);

      const { date, name } = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        name: z.string().nullable(),
      }).parse(req.body);

      if (name === null) {
        await academicDb().schoolHoliday.deleteMany({ where: { institutionId, date } });
      } else {
        await academicDb().schoolHoliday.upsert({
          where: { institutionId_date: { institutionId, date } },
          create: { institutionId, date, name },
          update: { name },
        });
      }
      res.json({ success: true });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
      next(err);
    }
  }
);

// ── GET /attendance/:divisionId/daily?date=YYYY-MM-DD ────────────────────────
router.get(
  "/attendance/:divisionId/daily",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      await assertDivisionAccess(userId, institutionId, divisionId);

      const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.date as string);
      const year = await resolveRequestedAcademicYear(
        req.query.academicYearId as string | undefined,
        institutionId,
        { role: req.user!.role, userId: req.user!.userId }
      );

      const [records, dayNote] = await Promise.all([
        academicDb().attendance.findMany({
          where: { divisionId, institutionId, academicYearId: year.id, date },
          select: { studentId: true, status: true, remark: true },
        }),
        academicDb().attendanceDayNote.findUnique({
          where: { divisionId_date: { divisionId, date } },
          select: { note: true },
        }),
      ]);

      res.json({ success: true, data: { records, dateNote: dayNote?.note ?? "" } });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
      next(err);
    }
  }
);

// ── POST /attendance/:divisionId/daily ───────────────────────────────────────
router.post(
  "/attendance/:divisionId/daily",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      await assertClassTeacher(userId, institutionId, divisionId);

      const { date, records, dateNote } = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        records: z.array(z.object({
          studentId: z.string(),
          status: z.enum(["P", "A", "L"]),
          remark: z.string().optional().default(""),
        })),
        dateNote: z.string().optional(),
      }).parse(req.body);

      // Year resolution and the writes below must use the same client —
      // academicDb() — so a BYOD institution's academicYearId and its
      // Attendance rows live in the same (tenant) database.
      const currentYear = await getCurrentAcademicYear(institutionId);
      await academicDb().$transaction(async (tx) => {
        // Upsert each attendance record
        for (const rec of records) {
          await tx.attendance.upsert({
            where: { divisionId_studentId_date: { divisionId, studentId: rec.studentId, date } },
            create: { institutionId, divisionId, studentId: rec.studentId, date, status: rec.status, remark: rec.remark || null, academicYearId: currentYear.id },
            update: { status: rec.status, remark: rec.remark || null },
          });
        }
        // Upsert day note if provided
        if (dateNote !== undefined) {
          if (dateNote.trim()) {
            await tx.attendanceDayNote.upsert({
              where: { divisionId_date: { divisionId, date } },
              create: { institutionId, divisionId, date, note: dateNote.trim() },
              update: { note: dateNote.trim() },
            });
          } else {
            await tx.attendanceDayNote.deleteMany({ where: { divisionId, date } });
          }
        }
      });

      // The admin Analytics "Attendance Analysis" card caches its numbers for
      // 5 minutes (insights.controller.ts#getAttendanceInsights) keyed by
      // institution + current calendar month. Without busting it here, a
      // teacher marking/correcting attendance wouldn't show up on that card
      // until the old cache entry naturally expired — same fix already
      // applied to fee-payment edits busting insights:fee-ai.
      const now = new Date();
      const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      await delCache(`insights:attendance:${institutionId}:${currentMonthKey}`);

      const attDivision = await academicDb().division.findFirst({
        where: { id: divisionId, institutionId },
        select: { name: true, standard: { select: { name: true } } },
      });
      logAudit("ATTENDANCE_MARKED", {
        userId,
        actorRole: "TEACHER",
        institutionId,
        details: `Marked attendance for ${attDivision ? `${attDivision.standard.name} - ${attDivision.name}` : divisionId} (${records.length} students)`,
      });

      res.json({ success: true });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
      next(err);
    }
  }
);

// ── GET /attendance/:divisionId/monthly?month=YYYY-MM ────────────────────────
router.get(
  "/attendance/:divisionId/monthly",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      await assertDivisionAccess(userId, institutionId, divisionId);

      const month = z.string().regex(/^\d{4}-\d{2}$/).parse(req.query.month as string);
      const dateStart = `${month}-01`;
      const dateEnd = `${month}-31`;
      const year = await resolveRequestedAcademicYear(
        req.query.academicYearId as string | undefined,
        institutionId,
        { role: req.user!.role, userId: req.user!.userId }
      );

      const records = await academicDb().attendance.findMany({
        where: { divisionId, institutionId, academicYearId: year.id, date: { gte: dateStart, lte: dateEnd } },
        select: { studentId: true, date: true, status: true, remark: true },
      });

      res.json({ success: true, data: { records } });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
      next(err);
    }
  }
);

// ── GET /attendance/:divisionId/summary ───────────────────────────────────────
router.get(
  "/attendance/:divisionId/summary",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      await assertDivisionAccess(userId, institutionId, divisionId);

      const year = await resolveRequestedAcademicYear(
        req.query.academicYearId as string | undefined,
        institutionId,
        { role: req.user!.role, userId: req.user!.userId }
      );

      const now = new Date();
      // "Current month" only has meaning when the resolved year is the live
      // one — a historical year has no current month.
      const currentMonth = year.isCurrent ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}` : "";

      // Academic session runs June–May — the cumulative % must reset at the
      // start of each session and only ever accumulate within it. Window
      // comes from the resolved year's own dates, not "today".
      const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
      const sessionStart = toDateStr(year.startDate);
      const sessionEnd = toDateStr(year.endDate);

      const [students, allRecords, holidays] = await Promise.all([
        year.isCurrent
          ? academicDb().student.findMany({
              where: { divisionId, institutionId },
              orderBy: [{ rollNo: "asc" }, { joinedAt: "asc" }],
            })
          : academicDb().studentEnrollment
              .findMany({
                where: { divisionId, academicYearId: year.id, institutionId },
                orderBy: [{ rollNo: "asc" }, { student: { joinedAt: "asc" } }],
                include: { student: true },
              })
              .then((rows) => rows.map((e) => ({ ...e.student, rollNo: e.rollNo ?? e.student.rollNo }))),
        academicDb().attendance.findMany({
          where: { divisionId, institutionId, academicYearId: year.id, date: { gte: sessionStart, lte: sessionEnd } },
          select: { studentId: true, date: true, status: true },
        }),
        academicDb().schoolHoliday.findMany({
          where: { institutionId, date: { gte: sessionStart, lte: sessionEnd } },
          select: { date: true },
        }),
      ]);
      const cumulativeUserMap = await resolveUsers(students.map((s) => s.userId), { id: true, name: true });

      // A date later declared a holiday must not count toward attendance %,
      // even if a record was marked before the holiday was declared — this
      // matches the sheet UI, which already excludes holiday cells from its
      // own on-screen totals.
      const holidayDates = new Set(holidays.map((h) => h.date));
      const validRecords = allRecords.filter((r) => !holidayDates.has(r.date));

      // Group records by studentId
      const byStudent: Record<string, { date: string; status: string }[]> = {};
      validRecords.forEach((r) => {
        if (!byStudent[r.studentId]) byStudent[r.studentId] = [];
        byStudent[r.studentId].push({ date: r.date, status: r.status });
      });

      const calcPct = (p: number, a: number, l: number): number | null => {
        const t = p + a + l;
        return t > 0 ? Math.round(((p + l) / t) * 100) : null;
      };

      const summaryStudents = students.map((s) => {
        const recs = byStudent[s.id] ?? [];

        // Current month
        const curRecs = recs.filter((r) => r.date.startsWith(currentMonth));
        let cP = 0, cA = 0, cL = 0;
        curRecs.forEach((r) => { if (r.status === "P") cP++; else if (r.status === "A") cA++; else if (r.status === "L") cL++; });
        const currentMonthPct = calcPct(cP, cA, cL);

        // Per month
        const monthGroups: Record<string, { p: number; a: number; l: number }> = {};
        recs.forEach((r) => {
          const mk = r.date.slice(0, 7);
          if (!monthGroups[mk]) monthGroups[mk] = { p: 0, a: 0, l: 0 };
          if (r.status === "P") monthGroups[mk].p++;
          else if (r.status === "A") monthGroups[mk].a++;
          else if (r.status === "L") monthGroups[mk].l++;
        });

        // monthKey strings sort chronologically within a single June–May
        // session. The cumulative % through a given month is the running
        // average of each month's own % from session start through that
        // month (not a weighted total of raw record counts).
        let pctSum = 0;
        let pctCount = 0;
        const monthlyStats = Object.entries(monthGroups)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mk, c]) => {
            const pct = calcPct(c.p, c.a, c.l);
            if (pct !== null) { pctSum += pct; pctCount++; }
            return {
              monthKey: mk, p: c.p, a: c.a, l: c.l, pct,
              cumulativePct: pctCount > 0 ? Math.round(pctSum / pctCount) : null,
            };
          });

        // "Overall" = cumulative through the most recent month with data.
        const overallPct = monthlyStats.length > 0 ? monthlyStats[monthlyStats.length - 1].cumulativePct : null;

        return {
          studentId: s.id,
          name: cumulativeUserMap.get(s.userId)?.name ?? null,
          rollNo: s.rollNo ?? "",
          avatarUrl: s.avatarUrl,
          overallPct,
          currentMonthPct,
          monthlyStats,
        };
      });

      const rawSummaryAvatars = summaryStudents.map(st => st.avatarUrl ?? null);
      const summaryAvatarMap = await generateSignedAvatarUrlsBatch(rawSummaryAvatars);
      const resolvedSummaryStudents = summaryStudents.map(st => ({
        ...st,
        avatarUrl: st.avatarUrl ? (summaryAvatarMap[st.avatarUrl] ?? st.avatarUrl) : null,
      }));

      // Class-level stats — only average students who have actual data
      const withOverall = summaryStudents.filter((st) => st.overallPct !== null);
      const classOverallPct = withOverall.length > 0
        ? Math.round(withOverall.reduce((s, st) => s + st.overallPct!, 0) / withOverall.length)
        : null;
      const withMonth = summaryStudents.filter((st) => st.currentMonthPct !== null);
      const classCurrentMonthPct = withMonth.length > 0
        ? Math.round(withMonth.reduce((s, st) => s + st.currentMonthPct!, 0) / withMonth.length)
        : null;

      // Class monthly averages — collect all month keys
      const allMonthKeys = new Set<string>();
      summaryStudents.forEach((st) => st.monthlyStats.forEach((m) => allMonthKeys.add(m.monthKey)));
      const classMonthlyStats = Array.from(allMonthKeys).sort().map((mk) => {
        const pcts = summaryStudents
          .map((st) => st.monthlyStats.find((m) => m.monthKey === mk)?.pct ?? null)
          .filter((p): p is number => p !== null);
        const avg = pcts.length > 0 ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
        const cumPcts = summaryStudents
          .map((st) => st.monthlyStats.find((m) => m.monthKey === mk)?.cumulativePct ?? null)
          .filter((p): p is number => p !== null);
        const cumulativeAvg = cumPcts.length > 0 ? Math.round(cumPcts.reduce((a, b) => a + b, 0) / cumPcts.length) : null;
        return { monthKey: mk, avg, cumulativeAvg };
      });

      res.json({
        success: true,
        data: {
          students: resolvedSummaryStudents,
          classStats: { overallPct: classOverallPct, currentMonthPct: classCurrentMonthPct, monthlyStats: classMonthlyStats },
        },
      });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
      next(err);
    }
  }
);

// ── GET /attendance/:divisionId/student-records/:studentId ────────────────────
router.get(
  "/attendance/:divisionId/student-records/:studentId",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      const studentId = req.params.studentId as string;
      await assertDivisionAccess(userId, institutionId, divisionId);

      const yearStr = req.query.year as string | undefined;
      const startDateParam = req.query.startDate as string | undefined;
      const endDateParam = req.query.endDate as string | undefined;

      let dateFilter: { gte: string; lte: string };
      if (startDateParam && endDateParam) {
        dateFilter = { gte: startDateParam, lte: endDateParam };
      } else {
        const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
        dateFilter = { gte: `${year}-01-01`, lte: `${year}-12-31` };
      }

      const records = await academicDb().attendance.findMany({
        where: {
          divisionId,
          institutionId,
          studentId,
          date: dateFilter,
        },
        select: { date: true, status: true, remark: true },
        orderBy: { date: "asc" },
      });

      res.json({ success: true, data: { records } });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) { res.status(e.status).json({ success: false, error: e.message }); return; }
      next(err);
    }
  }
);

// ── Marksheet ─────────────────────────────────────────────────────────────────
router.post("/marksheet/division/:divisionId/init", ...T, initMarksheet);
router.get("/marksheet/division/:divisionId", ...T, getDivisionMarksheet);
router.get("/marksheet/division/:divisionId/online", ...T, getDivisionOnlineMarksheet);
router.post("/marksheet/:id/columns", ...T, addColumn);
router.patch("/marksheet/:id/columns/:colId", ...T, editColumn);
router.delete("/marksheet/:id/columns/:colId", ...T, deleteColumn);
router.put("/marksheet/:id/columns/:subjectId/reorder", ...T, reorderColumns);
router.put("/marksheet/:id/subjects/:subjectId/config", ...T, setSubjectConfig);
router.put("/marksheet/:id/scores/subject/:subjectId", ...T, bulkUpsertScores);
router.post("/marksheet/:id/graded-subjects", ...T, addGradedSubject);
router.patch("/marksheet/:id/graded-subjects/:gsId", ...T, editGradedSubject);
router.delete("/marksheet/:id/graded-subjects/:gsId", ...T, deleteGradedSubject);
router.put("/marksheet/:id/graded-subjects/reorder", ...T, reorderGradedSubjects);
router.patch("/marksheet/:id/graded-section-title", ...T, updateGradedSectionTitle);
router.patch("/marksheet/:id/grade-scale", ...T, updateMarksheetGradeScale);
router.put("/marksheet/:id/graded-scores", ...T, bulkUpsertGradedScores);
router.put("/marksheet/:id/remarks/:studentId", ...T, upsertMarksheetRemark);
router.post("/marksheet/:id/publish", ...T, publishMarksheet);
router.get("/marksheet/:id/download", ...T, downloadMarksheet);

// ── Notepad ───────────────────────────────────────────────────────────────────
router.get("/notepad", ...T, getNotepad);
router.post("/notepad/notes", ...T, createNote);
router.patch("/notepad/notes/:id", ...T, updateNote);
router.delete("/notepad/notes/:id", ...T, deleteNote);
router.post("/notepad/tasks", ...T, createTask);
router.patch("/notepad/tasks/:id", ...T, updateTask);
router.delete("/notepad/tasks/:id", ...T, deleteTask);

// ── Students — Upload Photo (class teacher only) ──────────────────────────────
// Multer must run before academicRoutingMiddleware — same reason as /photo above.
router.post(
  "/classes/:divisionId/students/:studentId/photo",
  authMiddleware(["TEACHER"]),
  institutionAccessMiddleware,
  photoUpload.single("photo"),
  academicRoutingMiddleware,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;
      const studentId = req.params.studentId as string;

      if (!req.file) { res.status(400).json({ success: false, error: "No photo file provided" }); return; }

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) { res.status(404).json({ success: false, error: "Teacher profile not found" }); return; }

      const classAssignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) { res.status(403).json({ success: false, error: "Only class teacher can update student photos" }); return; }

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true },
      });
      if (!student) { res.status(404).json({ success: false, error: "Student not found" }); return; }

      const { publicUrl } = await uploadImageToR2(req.file.buffer, {
        contentType: req.file.mimetype,
        folder: "student-photos",
        ownerId: student.id,
      });

      await academicDb().student.update({ where: { id: student.id }, data: { avatarUrl: publicUrl } });

      const signedUrl = (await generateSignedAvatarUrl(publicUrl)) ?? publicUrl;
      res.json({ success: true, data: { avatarUrl: signedUrl } });
    } catch (err) {
      next(err);
    }
  }
);

// ── Timetable — Upload (class teacher only) ────────────────────────────────────
// Multer must run before academicRoutingMiddleware — same reason as /photo above.
// Stored as a plain public R2 URL (like fee-structure qrImageUrl/schoolLogoUrl) —
// class timetable isn't sensitive per-user data, so no signed-URL step needed.
router.post(
  "/classes/:divisionId/timetable",
  authMiddleware(["TEACHER"]),
  institutionAccessMiddleware,
  photoUpload.single("timetable"),
  academicRoutingMiddleware,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) { res.status(400).json({ success: false, error: "No institution" }); return; }
      const divisionId = req.params.divisionId as string;

      if (!req.file) { res.status(400).json({ success: false, error: "No timetable file provided" }); return; }

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) { res.status(404).json({ success: false, error: "Teacher profile not found" }); return; }

      const classAssignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId, subjectId: null },
        select: { id: true },
      });
      if (!classAssignment) { res.status(403).json({ success: false, error: "Only the class teacher can upload the timetable" }); return; }

      const division = await academicDb().division.findFirst({
        where: { id: divisionId, institutionId },
        select: { id: true },
      });
      if (!division) { res.status(404).json({ success: false, error: "Division not found" }); return; }

      const { publicUrl } = await uploadImageToR2(req.file.buffer, {
        contentType: req.file.mimetype,
        folder: "timetables",
        ownerId: division.id,
      });

      const currentYear = await getCurrentAcademicYear(institutionId);
      const db = academicDb();
      await db.$transaction([
        db.division.update({ where: { id: division.id }, data: { timetableUrl: publicUrl } }),
        db.divisionTimetable.upsert({
          where: { divisionId_academicYearId: { divisionId: division.id, academicYearId: currentYear.id } },
          create: { institutionId, divisionId: division.id, academicYearId: currentYear.id, timetableUrl: publicUrl },
          update: { timetableUrl: publicUrl },
        }),
      ]);

      res.json({ success: true, data: { timetableUrl: publicUrl } });
    } catch (err) {
      next(err);
    }
  }
);

// ── Students — Stats ──────────────────────────────────────────────────────────
router.get(
  "/classes/:divisionId/students/:studentId/stats",
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

      const teacher = await academicDb().teacher.findFirst({
        where: { userId, institutionId },
        select: { id: true },
      });
      if (!teacher) {
        res.status(404).json({ success: false, error: "Teacher profile not found" });
        return;
      }

      const assignment = await academicDb().divisionAssignment.findFirst({
        where: { divisionId, teacherId: teacher.id, institutionId },
        select: { id: true },
      });
      if (!assignment) {
        res.status(403).json({ success: false, error: "Not assigned to this division" });
        return;
      }

      const data = await getStudentStatsData(studentId, divisionId, institutionId);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

// ── Students — Report (Yellow/Red Card) ───────────────────────────────────────
router.post(
  "/classes/:divisionId/students/:studentId/remarks",
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

      await assertDivisionAccess(userId, institutionId, divisionId);

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found in this division" });
        return;
      }

      const data = createRemarkSchema.parse(req.body);
      const remark = await createStudentRemark({
        institutionId,
        studentId,
        divisionId,
        reportedByUserId: userId,
        reportedByRole: "Faculty",
        viewer: { userId, role: "TEACHER" },
        data,
      });

      logAudit("STUDENT_REPORTED", {
        userId,
        actorRole: "TEACHER",
        institutionId,
        details: `${data.severity} severity report filed for student: ${data.title}`,
      });

      res.status(201).json({ success: true, data: remark });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

// ── GET /classes/:divisionId/leaderboard — rank + attendance % per student ────
router.get(
  "/classes/:divisionId/leaderboard",
  ...T,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId, institutionId } = req.user!;
      if (!institutionId) {
        res.status(400).json({ success: false, error: "No institution" });
        return;
      }
      const divisionId = req.params.divisionId as string;

      await assertDivisionAccess(userId, institutionId, divisionId);

      const data = await getDivisionLeaderboardData(divisionId, institutionId);
      res.json({ success: true, data });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

// ── GET /classes/:divisionId/students/:studentId/remarks — list remarks ──────
router.get(
  "/classes/:divisionId/students/:studentId/remarks",
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

      await assertDivisionAccess(userId, institutionId, divisionId);

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found in this division" });
        return;
      }

      const remarks = await listStudentRemarks(studentId, institutionId, { userId, role: "TEACHER" });
      res.json({ success: true, data: remarks });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

// ── PTM Notes — logged live during a Parent-Teacher Meeting ──────────────────
router.post(
  "/classes/:divisionId/students/:studentId/ptm-notes",
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

      await assertDivisionAccess(userId, institutionId, divisionId);

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found in this division" });
        return;
      }

      const { note } = z.object({ note: z.string().trim().min(1).max(1000) }).parse(req.body);
      const created = await createPTMNote({ institutionId, studentId, createdByUserId: userId, createdByRole: "Faculty", note });

      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

router.patch(
  "/classes/:divisionId/students/:studentId/ptm-notes/:noteId",
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
      const noteId = req.params.noteId as string;

      await assertDivisionAccess(userId, institutionId, divisionId);

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found in this division" });
        return;
      }

      const { note } = z.object({ note: z.string().trim().min(1).max(1000) }).parse(req.body);
      const updated = await editPTMNote({ noteId, studentId, institutionId, viewerUserId: userId, note });

      res.json({ success: true, data: updated });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

router.get(
  "/classes/:divisionId/students/:studentId/ptm-notes",
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

      await assertDivisionAccess(userId, institutionId, divisionId);

      const student = await academicDb().student.findFirst({
        where: { id: studentId, divisionId, institutionId },
        select: { id: true },
      });
      if (!student) {
        res.status(404).json({ success: false, error: "Student not found in this division" });
        return;
      }

      const notes = await listPTMNotes(studentId, institutionId);
      res.json({ success: true, data: notes });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

// ── GET /reports/inbox — reports assigned to me for review ───────────────────
router.get("/reports/inbox", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const reports = await listAssignedRemarks(institutionId, { userId, role: "TEACHER" });
    res.json({ success: true, data: reports });
  } catch (err) {
    next(err);
  }
});

// ── GET /reports/submitted — reports I have filed, with status history ───────
router.get("/reports/submitted", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const reports = await listSubmittedRemarks(institutionId, { userId, role: "TEACHER" });
    res.json({ success: true, data: reports });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /reports/:remarkId — review/action a report (assignee or admin) ────
router.patch("/reports/:remarkId", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const remarkId = req.params.remarkId as string;
    const data = reviewRemarkSchema.parse(req.body);
    const updated = await reviewStudentRemark({
      remarkId,
      institutionId,
      viewer: { userId, role: "TEACHER" },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      res.status(e.status).json({ success: false, error: e.message });
      return;
    }
    next(err);
  }
});

// ── PATCH /reports/:remarkId/edit — reporter edits their own card's content ──
router.patch("/reports/:remarkId/edit", ...T, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { userId, institutionId } = req.user!;
    if (!institutionId) {
      res.status(400).json({ success: false, error: "No institution" });
      return;
    }
    const remarkId = req.params.remarkId as string;
    const data = editRemarkSchema.parse(req.body);
    const updated = await editStudentRemark({
      remarkId,
      institutionId,
      viewer: { userId, role: "TEACHER" },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) {
      res.status(e.status).json({ success: false, error: e.message });
      return;
    }
    next(err);
  }
});

// ── GET /classes/:divisionId/students/:studentId/marksheet — full breakdown ──
router.get(
  "/classes/:divisionId/students/:studentId/marksheet",
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

      await assertDivisionAccess(userId, institutionId, divisionId);

      const data = await getStudentMarksheetData(divisionId, studentId, institutionId);
      if (!data) {
        res.status(404).json({ success: false, error: "Results not published yet" });
        return;
      }
      res.json({ success: true, data });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

// ── GET /classes/:divisionId/students/:studentId/attendance-trend ────────────
router.get(
  "/classes/:divisionId/students/:studentId/attendance-trend",
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

      await assertDivisionAccess(userId, institutionId, divisionId);

      const data = await getStudentAttendanceTrendData(studentId, institutionId);
      res.json({ success: true, data });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

// ── GET /classes/:divisionId/students/:studentId/attendance ──────────────────
router.get(
  "/classes/:divisionId/students/:studentId/attendance",
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

      await assertDivisionAccess(userId, institutionId, divisionId);

      const data = await getStudentAttendanceDetailData(studentId, institutionId);
      res.json({ success: true, data });
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
