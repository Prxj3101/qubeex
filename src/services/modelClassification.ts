// BYOD model classification — the single source of truth for which Prisma models
// live in the central DB always (PLATFORM) vs. which route to an institution's own
// database when it is on BYOD (ACADEMIC).
//
// Keep this in sync with prisma/schema.prisma. The completeness test in
// modelClassification.test.ts fails if a model is added to the schema without
// being classified here.

// Platform / SaaS-level data — always stored in the QubeEx central database.
export const PLATFORM_MODELS = [
  "Institution",
  "User",
  "InstitutionDbConfig",
  "WhiteLabelConfig",
  "SubAdmin",
  "Invite",
  "Subscription",
  "Plan",
  "Bill",
  "SupportTicket",
  "DemoRequest",
  "TicketReply",
  "Review",
  "Notification",
  "NotificationRecipient",
  "AuditLog",
  "UserStatusEvent",
  "PlatformSettings",
  // File-deletion bookkeeping for the central R2 store (files stay central in v1).
  "PendingFileDeletion",
  // AI token-pool usage/billing events — references User directly, same domain
  // as the shared per-institution AI token pool tracked centrally.
  "AiUsageEvent",
  // Per-user device push tokens and Jarvis chat history - both keyed by User and
  // read/written through the central client.
  "PushToken",
  "AiChatMessage",
] as const;

// Academic / institution-owned data — routes to the tenant DB for BYOD institutions,
// stays in the central DB for managed institutions.
export const ACADEMIC_MODELS = [
  "Teacher",
  "TeacherNote",
  "TeacherTask",
  "AdminNote",
  "AdminTask",
  "Standard",
  "Division",
  "Subject",
  "DivisionSubject",
  "DivisionAssignment",
  "Student",
  "PromotionBatch",
  "StudentPromotionOutcome",
  "StudentRemark",
  "PTMNote",
  "ParentModeEvent",
  "Attendance",
  "SchoolHoliday",
  "AttendanceDayNote",
  "StaffPost",
  "StaffPostReaction",
  "StaffPostComment",
  "StaffMessage",
  "CampusFeedPost",
  "CalendarEvent",
  "DivisionFeeStructure",
  "StudentFeePayment",
  "BlackboardFolder",
  "BlackboardMaterial",
  "Mindmap",
  "TaskContainer",
  "TaskQuestion",
  "TaskModule",
  "TaskModuleQuestion",
  "TaskTest",
  "TaskTestQuestion",
  "TaskTestAttempt",
  "TaskStudentAnswer",
  "TaskPdfUpload",
  "QuestionShareToken",
  "TaskAssignment",
  "TaskAssignmentSubmission",
  "TaskAssignmentSubmissionAttempt",
  "Marksheet",
  "MarksheetSubjectConfig",
  "MarksheetExamColumn",
  "MarksheetScore",
  "MarksheetGradedSubject",
  "MarksheetGradedScore",
  "MarksheetRemark",
  "TranslationCache",
  // Payroll — per-institution staff salary data, lives with academic data.
  "PayrollSettings",
  "SalaryComponent",
  "SalaryTemplate",
  "Staff",
  "StaffSalaryStructure",
  "PayrollRun",
  "Payslip",
  "StaffAttendance",
  "StaffPunch",
] as const;

const academicSet = new Set<string>(ACADEMIC_MODELS);

export const isAcademicModel = (name: string): boolean => academicSet.has(name);
