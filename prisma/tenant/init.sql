Loaded Prisma config from prisma.config.ts.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'TEACHER', 'STUDENT');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'GRADUATED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PromotionOutcome" AS ENUM ('PROMOTED', 'REPEATED', 'GRADUATED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "InstitutionType" AS ENUM ('SCHOOL', 'COLLEGE', 'COACHING');

-- CreateEnum
CREATE TYPE "InstitutionStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAUSED', 'EXPIRED', 'LOCKED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "TeacherStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MarksheetStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('ADMIN_ACTION', 'SECURITY', 'SYSTEM', 'BILLING', 'SUPERADMIN_ACTION');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RemarkCardType" AS ENUM ('YELLOW', 'RED');

-- CreateEnum
CREATE TYPE "RemarkStatus" AS ENUM ('ACTIVE', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED', 'APPEALED');

-- CreateEnum
CREATE TYPE "RemarkSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "TrialOutcome" AS ENUM ('EXTENDED', 'ACTIVATED', 'CHURNED');

-- CreateEnum
CREATE TYPE "CampusPostType" AS ENUM ('ANNOUNCEMENT', 'NOTICE', 'MATERIAL', 'RESULT');

-- CreateEnum
CREATE TYPE "CalendarEventType" AS ENUM ('HOLIDAY', 'TEST', 'TERMTEST', 'EXAM', 'SUBMISSION', 'MEETING', 'SPORTS', 'EVENT', 'TRIP');

-- CreateEnum
CREATE TYPE "TaskQuestionType" AS ENUM ('MCQ', 'FILL_BLANK', 'TRUE_FALSE', 'SHORT_ANSWER', 'NUMERICAL', 'CONCEPTUAL');

-- CreateEnum
CREATE TYPE "TaskQuestionStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskQuestionSource" AS ENUM ('AI', 'MANUAL', 'IMPORTED');

-- CreateEnum
CREATE TYPE "TaskTestStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TaskAssignmentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED');

-- CreateTable
CREATE TABLE "Teacher" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "phone" TEXT,
    "avatarUrl" TEXT,
    "dob" TEXT,
    "gender" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "country" TEXT DEFAULT 'India',
    "qualification" TEXT,
    "experience" TEXT,
    "prefix" TEXT,
    "title" TEXT DEFAULT 'Teacher',
    "aiSoftLimitTokens" INTEGER,
    "status" "TeacherStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherNote" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherTask" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Standard" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Standard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Division" (
    "id" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "timetableUrl" TEXT,
    "classTeacherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "color" TEXT,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DivisionSubject" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,

    CONSTRAINT "DivisionSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DivisionAssignment" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "subjectId" TEXT,
    "teacherId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DivisionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "standardId" TEXT,
    "divisionId" TEXT,
    "phone" TEXT,
    "avatarUrl" TEXT,
    "dob" TEXT,
    "gender" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "country" TEXT DEFAULT 'India',
    "rollNo" TEXT,
    "houseColor" TEXT,
    "bloodGroup" TEXT,
    "aadharNo" TEXT,
    "panNo" TEXT,
    "emergencyContact" TEXT,
    "religion" TEXT,
    "category" TEXT,
    "nationality" TEXT,
    "admissionYear" TEXT,
    "guardians" JSONB,
    "extraDetailFields" JSONB,
    "tempPassword" TEXT,
    "hasLoggedIn" BOOLEAN NOT NULL DEFAULT false,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionBatch" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "fromStandardId" TEXT NOT NULL,
    "fromDivisionId" TEXT NOT NULL,
    "toDivisionId" TEXT,
    "academicYear" TEXT NOT NULL,
    "triggeredById" TEXT NOT NULL,
    "triggeredByRole" TEXT NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentPromotionOutcome" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "outcome" "PromotionOutcome" NOT NULL,
    "previousStandardId" TEXT NOT NULL,
    "previousDivisionId" TEXT NOT NULL,
    "previousStatus" "StudentStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentPromotionOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentRemark" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" "RemarkCardType" NOT NULL,
    "severity" "RemarkSeverity" NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "subject" TEXT,
    "actionTaken" TEXT,
    "status" "RemarkStatus" NOT NULL DEFAULT 'ACTIVE',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "reportedByUserId" TEXT NOT NULL,
    "reportedByRole" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "reviewRemark" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentRemark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolHoliday" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDayNote" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "note" TEXT NOT NULL,

    CONSTRAINT "AttendanceDayNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPost" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "attachmentType" TEXT,
    "attachmentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPostReaction" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,

    CONSTRAINT "StaffPostReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffMessage" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "text" TEXT,
    "attachmentUrl" TEXT,
    "attachmentType" TEXT,
    "attachmentName" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampusFeedPost" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "divisionId" TEXT,
    "subjectId" TEXT,
    "type" "CampusPostType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "subject" TEXT,
    "attachmentUrl" TEXT,
    "attachmentType" TEXT,
    "attachmentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampusFeedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "divisionId" TEXT,
    "type" "CalendarEventType" NOT NULL,
    "label" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DivisionFeeStructure" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "feeStructures" JSONB NOT NULL,
    "feeMonths" JSONB NOT NULL,
    "bankDetails" JSONB,
    "qrImageUrl" TEXT,
    "extraColumns" JSONB NOT NULL,
    "extraStudentFields" JSONB NOT NULL,
    "generalRemark" TEXT,
    "feeCardTheme" TEXT,
    "schoolLogoUrl" TEXT,
    "schoolName" TEXT,
    "rulesAndRegs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DivisionFeeStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentFeePayment" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "feeMonthId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidDate" TEXT,
    "remark" TEXT,
    "extraFields" JSONB,
    "extraStructureIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentFeePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackboardFolder" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlackboardFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackboardMaterial" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlackboardMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskContainer" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskContainer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskQuestion" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "type" "TaskQuestionType" NOT NULL,
    "status" "TaskQuestionStatus" NOT NULL DEFAULT 'APPROVED',
    "source" "TaskQuestionSource" NOT NULL DEFAULT 'AI',
    "sourceFile" TEXT,
    "uploadBatchId" TEXT,
    "question" TEXT NOT NULL,
    "questionTemplate" TEXT,
    "options" JSONB,
    "answer" TEXT NOT NULL,
    "details" JSONB,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskModule" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskModuleQuestion" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskModuleQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTest" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "testLink" TEXT NOT NULL,
    "status" "TaskTestStatus" NOT NULL DEFAULT 'DRAFT',
    "paperType" TEXT NOT NULL DEFAULT 'TEST',
    "isRandomized" BOOLEAN NOT NULL DEFAULT false,
    "answerSpace" BOOLEAN NOT NULL DEFAULT true,
    "sections" JSONB,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "totalMarks" INTEGER NOT NULL DEFAULT 100,
    "numberOfQuestions" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTestQuestion" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "isCompulsory" BOOLEAN NOT NULL DEFAULT false,
    "sectionId" TEXT,
    "marks" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaskTestQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTestAttempt" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "studentId" TEXT,
    "studentName" TEXT NOT NULL,
    "rollNo" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3),
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "maxScore" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "tabChangeCount" INTEGER NOT NULL DEFAULT 0,
    "malpracticeFlag" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TaskTestAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskStudentAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "generatedQuestion" TEXT NOT NULL,
    "generatedOptions" JSONB,
    "studentAnswer" TEXT,
    "correctAnswer" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskStudentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskPdfUpload" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "questionCount" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskPdfUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionShareToken" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "sourceContainerId" TEXT NOT NULL,
    "questionIds" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionShareToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignment" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "totalMarks" INTEGER NOT NULL DEFAULT 10,
    "dueDate" TIMESTAMP(3),
    "status" "TaskAssignmentStatus" NOT NULL DEFAULT 'DRAFT',
    "submissionType" TEXT NOT NULL DEFAULT 'OFFLINE',
    "sections" JSONB,
    "questions" JSONB,
    "isRandomized" BOOLEAN NOT NULL DEFAULT false,
    "answerSpace" BOOLEAN NOT NULL DEFAULT true,
    "numberOfQuestions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignmentSubmission" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "fileKey" TEXT,
    "fileUrl" TEXT,
    "submittedAt" TIMESTAMP(3),
    "resubmitCount" INTEGER NOT NULL DEFAULT 0,
    "reviewStatus" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByTeacherId" TEXT,
    "offlineSubmittedAt" TIMESTAMP(3),
    "offlineMarkedByTeacherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskAssignmentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignmentSubmissionAttempt" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "fileKey" TEXT,
    "fileUrl" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewStatus" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByTeacherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAssignmentSubmissionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Marksheet" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "createdByTeacherId" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "status" "MarksheetStatus" NOT NULL DEFAULT 'DRAFT',
    "pdfR2Key" TEXT,
    "shareToken" TEXT NOT NULL,
    "gradedSectionTitle" TEXT NOT NULL DEFAULT 'Graded Subjects',
    "gradeScale" JSONB NOT NULL DEFAULT '[]',
    "publishedSnapshot" JSONB,
    "publishedAt" TIMESTAMP(3),
    "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Marksheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarksheetSubjectConfig" (
    "id" TEXT NOT NULL,
    "marksheetId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "passingMarks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gradeScale" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "MarksheetSubjectConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarksheetExamColumn" (
    "id" TEXT NOT NULL,
    "marksheetId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxMarks" DOUBLE PRECISION NOT NULL,
    "examDate" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdByTeacherId" TEXT NOT NULL,

    CONSTRAINT "MarksheetExamColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarksheetScore" (
    "id" TEXT NOT NULL,
    "marksheetId" TEXT NOT NULL,
    "examColumnId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "isAbsent" BOOLEAN NOT NULL DEFAULT false,
    "enteredByTeacherId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarksheetScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarksheetGradedSubject" (
    "id" TEXT NOT NULL,
    "marksheetId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MarksheetGradedSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarksheetGradedScore" (
    "id" TEXT NOT NULL,
    "marksheetId" TEXT NOT NULL,
    "gradedSubjectId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "term1Grade" TEXT,
    "term2Grade" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarksheetGradedScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarksheetRemark" (
    "id" TEXT NOT NULL,
    "marksheetId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "conduct" TEXT,
    "remarks" TEXT,
    "updatedByTeacherId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarksheetRemark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_userId_key" ON "Teacher"("userId");

-- CreateIndex
CREATE INDEX "Teacher_institutionId_idx" ON "Teacher"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_teacherId_institutionId_key" ON "Teacher"("teacherId", "institutionId");

-- CreateIndex
CREATE INDEX "TeacherNote_teacherId_idx" ON "TeacherNote"("teacherId");

-- CreateIndex
CREATE INDEX "TeacherTask_teacherId_idx" ON "TeacherTask"("teacherId");

-- CreateIndex
CREATE INDEX "Standard_institutionId_idx" ON "Standard"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Standard_institutionId_name_key" ON "Standard"("institutionId", "name");

-- CreateIndex
CREATE INDEX "Division_institutionId_idx" ON "Division"("institutionId");

-- CreateIndex
CREATE INDEX "Division_standardId_idx" ON "Division"("standardId");

-- CreateIndex
CREATE UNIQUE INDEX "Division_standardId_name_key" ON "Division"("standardId", "name");

-- CreateIndex
CREATE INDEX "Subject_standardId_idx" ON "Subject"("standardId");

-- CreateIndex
CREATE INDEX "Subject_institutionId_idx" ON "Subject"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_standardId_name_key" ON "Subject"("standardId", "name");

-- CreateIndex
CREATE INDEX "DivisionSubject_divisionId_idx" ON "DivisionSubject"("divisionId");

-- CreateIndex
CREATE UNIQUE INDEX "DivisionSubject_divisionId_subjectId_key" ON "DivisionSubject"("divisionId", "subjectId");

-- CreateIndex
CREATE INDEX "DivisionAssignment_divisionId_idx" ON "DivisionAssignment"("divisionId");

-- CreateIndex
CREATE INDEX "DivisionAssignment_teacherId_idx" ON "DivisionAssignment"("teacherId");

-- CreateIndex
CREATE INDEX "DivisionAssignment_institutionId_idx" ON "DivisionAssignment"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");

-- CreateIndex
CREATE INDEX "Student_institutionId_idx" ON "Student"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_studentId_institutionId_key" ON "Student"("studentId", "institutionId");

-- CreateIndex
CREATE INDEX "PromotionBatch_institutionId_createdAt_idx" ON "PromotionBatch"("institutionId", "createdAt");

-- CreateIndex
CREATE INDEX "PromotionBatch_fromDivisionId_idx" ON "PromotionBatch"("fromDivisionId");

-- CreateIndex
CREATE INDEX "StudentPromotionOutcome_batchId_idx" ON "StudentPromotionOutcome"("batchId");

-- CreateIndex
CREATE INDEX "StudentPromotionOutcome_studentId_idx" ON "StudentPromotionOutcome"("studentId");

-- CreateIndex
CREATE INDEX "StudentRemark_studentId_idx" ON "StudentRemark"("studentId");

-- CreateIndex
CREATE INDEX "StudentRemark_institutionId_idx" ON "StudentRemark"("institutionId");

-- CreateIndex
CREATE INDEX "StudentRemark_assignedToUserId_status_idx" ON "StudentRemark"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "Attendance_divisionId_date_idx" ON "Attendance"("divisionId", "date");

-- CreateIndex
CREATE INDEX "Attendance_studentId_idx" ON "Attendance"("studentId");

-- CreateIndex
CREATE INDEX "Attendance_institutionId_idx" ON "Attendance"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_divisionId_studentId_date_key" ON "Attendance"("divisionId", "studentId", "date");

-- CreateIndex
CREATE INDEX "SchoolHoliday_institutionId_idx" ON "SchoolHoliday"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolHoliday_institutionId_date_key" ON "SchoolHoliday"("institutionId", "date");

-- CreateIndex
CREATE INDEX "AttendanceDayNote_divisionId_idx" ON "AttendanceDayNote"("divisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDayNote_divisionId_date_key" ON "AttendanceDayNote"("divisionId", "date");

-- CreateIndex
CREATE INDEX "StaffPost_institutionId_idx" ON "StaffPost"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPostReaction_postId_userId_key" ON "StaffPostReaction"("postId", "userId");

-- CreateIndex
CREATE INDEX "StaffPostComment_postId_idx" ON "StaffPostComment"("postId");

-- CreateIndex
CREATE INDEX "StaffMessage_institutionId_idx" ON "StaffMessage"("institutionId");

-- CreateIndex
CREATE INDEX "StaffMessage_senderId_idx" ON "StaffMessage"("senderId");

-- CreateIndex
CREATE INDEX "StaffMessage_receiverId_idx" ON "StaffMessage"("receiverId");

-- CreateIndex
CREATE INDEX "CampusFeedPost_institutionId_idx" ON "CampusFeedPost"("institutionId");

-- CreateIndex
CREATE INDEX "CampusFeedPost_divisionId_idx" ON "CampusFeedPost"("divisionId");

-- CreateIndex
CREATE INDEX "CampusFeedPost_subjectId_idx" ON "CampusFeedPost"("subjectId");

-- CreateIndex
CREATE INDEX "CalendarEvent_institutionId_idx" ON "CalendarEvent"("institutionId");

-- CreateIndex
CREATE INDEX "CalendarEvent_divisionId_idx" ON "CalendarEvent"("divisionId");

-- CreateIndex
CREATE UNIQUE INDEX "DivisionFeeStructure_divisionId_key" ON "DivisionFeeStructure"("divisionId");

-- CreateIndex
CREATE INDEX "DivisionFeeStructure_institutionId_idx" ON "DivisionFeeStructure"("institutionId");

-- CreateIndex
CREATE INDEX "StudentFeePayment_institutionId_idx" ON "StudentFeePayment"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentFeePayment_studentId_feeMonthId_key" ON "StudentFeePayment"("studentId", "feeMonthId");

-- CreateIndex
CREATE INDEX "BlackboardFolder_institutionId_teacherId_idx" ON "BlackboardFolder"("institutionId", "teacherId");

-- CreateIndex
CREATE INDEX "BlackboardFolder_teacherId_idx" ON "BlackboardFolder"("teacherId");

-- CreateIndex
CREATE INDEX "BlackboardFolder_institutionId_idx" ON "BlackboardFolder"("institutionId");

-- CreateIndex
CREATE INDEX "BlackboardMaterial_institutionId_teacherId_idx" ON "BlackboardMaterial"("institutionId", "teacherId");

-- CreateIndex
CREATE INDEX "BlackboardMaterial_folderId_idx" ON "BlackboardMaterial"("folderId");

-- CreateIndex
CREATE INDEX "BlackboardMaterial_teacherId_idx" ON "BlackboardMaterial"("teacherId");

-- CreateIndex
CREATE INDEX "TaskContainer_teacherId_subjectId_divisionId_idx" ON "TaskContainer"("teacherId", "subjectId", "divisionId");

-- CreateIndex
CREATE INDEX "TaskContainer_institutionId_idx" ON "TaskContainer"("institutionId");

-- CreateIndex
CREATE INDEX "TaskQuestion_teacherId_subjectId_idx" ON "TaskQuestion"("teacherId", "subjectId");

-- CreateIndex
CREATE INDEX "TaskQuestion_institutionId_idx" ON "TaskQuestion"("institutionId");

-- CreateIndex
CREATE INDEX "TaskQuestion_status_idx" ON "TaskQuestion"("status");

-- CreateIndex
CREATE INDEX "TaskModule_teacherId_subjectId_idx" ON "TaskModule"("teacherId", "subjectId");

-- CreateIndex
CREATE INDEX "TaskModule_institutionId_idx" ON "TaskModule"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskModuleQuestion_questionId_key" ON "TaskModuleQuestion"("questionId");

-- CreateIndex
CREATE INDEX "TaskModuleQuestion_moduleId_idx" ON "TaskModuleQuestion"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTest_testLink_key" ON "TaskTest"("testLink");

-- CreateIndex
CREATE INDEX "TaskTest_teacherId_idx" ON "TaskTest"("teacherId");

-- CreateIndex
CREATE INDEX "TaskTest_institutionId_idx" ON "TaskTest"("institutionId");

-- CreateIndex
CREATE INDEX "TaskTest_divisionId_idx" ON "TaskTest"("divisionId");

-- CreateIndex
CREATE INDEX "TaskTestQuestion_testId_idx" ON "TaskTestQuestion"("testId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTestQuestion_testId_questionId_key" ON "TaskTestQuestion"("testId", "questionId");

-- CreateIndex
CREATE INDEX "TaskTestAttempt_testId_idx" ON "TaskTestAttempt"("testId");

-- CreateIndex
CREATE INDEX "TaskTestAttempt_studentId_idx" ON "TaskTestAttempt"("studentId");

-- CreateIndex
CREATE INDEX "TaskStudentAnswer_attemptId_idx" ON "TaskStudentAnswer"("attemptId");

-- CreateIndex
CREATE INDEX "TaskPdfUpload_teacherId_idx" ON "TaskPdfUpload"("teacherId");

-- CreateIndex
CREATE INDEX "TaskPdfUpload_institutionId_idx" ON "TaskPdfUpload"("institutionId");

-- CreateIndex
CREATE INDEX "QuestionShareToken_institutionId_idx" ON "QuestionShareToken"("institutionId");

-- CreateIndex
CREATE INDEX "TaskAssignment_teacherId_divisionId_idx" ON "TaskAssignment"("teacherId", "divisionId");

-- CreateIndex
CREATE INDEX "TaskAssignment_institutionId_idx" ON "TaskAssignment"("institutionId");

-- CreateIndex
CREATE INDEX "TaskAssignmentSubmission_assignmentId_idx" ON "TaskAssignmentSubmission"("assignmentId");

-- CreateIndex
CREATE INDEX "TaskAssignmentSubmission_studentId_idx" ON "TaskAssignmentSubmission"("studentId");

-- CreateIndex
CREATE INDEX "TaskAssignmentSubmission_institutionId_idx" ON "TaskAssignmentSubmission"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskAssignmentSubmission_assignmentId_studentId_key" ON "TaskAssignmentSubmission"("assignmentId", "studentId");

-- CreateIndex
CREATE INDEX "TaskAssignmentSubmissionAttempt_submissionId_idx" ON "TaskAssignmentSubmissionAttempt"("submissionId");

-- CreateIndex
CREATE INDEX "TaskAssignmentSubmissionAttempt_assignmentId_idx" ON "TaskAssignmentSubmissionAttempt"("assignmentId");

-- CreateIndex
CREATE INDEX "TaskAssignmentSubmissionAttempt_studentId_idx" ON "TaskAssignmentSubmissionAttempt"("studentId");

-- CreateIndex
CREATE INDEX "TaskAssignmentSubmissionAttempt_institutionId_idx" ON "TaskAssignmentSubmissionAttempt"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Marksheet_shareToken_key" ON "Marksheet"("shareToken");

-- CreateIndex
CREATE INDEX "Marksheet_institutionId_idx" ON "Marksheet"("institutionId");

-- CreateIndex
CREATE INDEX "Marksheet_divisionId_idx" ON "Marksheet"("divisionId");

-- CreateIndex
CREATE UNIQUE INDEX "Marksheet_divisionId_academicYear_key" ON "Marksheet"("divisionId", "academicYear");

-- CreateIndex
CREATE INDEX "MarksheetSubjectConfig_marksheetId_idx" ON "MarksheetSubjectConfig"("marksheetId");

-- CreateIndex
CREATE UNIQUE INDEX "MarksheetSubjectConfig_marksheetId_subjectId_key" ON "MarksheetSubjectConfig"("marksheetId", "subjectId");

-- CreateIndex
CREATE INDEX "MarksheetExamColumn_marksheetId_subjectId_idx" ON "MarksheetExamColumn"("marksheetId", "subjectId");

-- CreateIndex
CREATE INDEX "MarksheetExamColumn_marksheetId_idx" ON "MarksheetExamColumn"("marksheetId");

-- CreateIndex
CREATE INDEX "MarksheetScore_marksheetId_idx" ON "MarksheetScore"("marksheetId");

-- CreateIndex
CREATE INDEX "MarksheetScore_examColumnId_idx" ON "MarksheetScore"("examColumnId");

-- CreateIndex
CREATE UNIQUE INDEX "MarksheetScore_examColumnId_studentId_key" ON "MarksheetScore"("examColumnId", "studentId");

-- CreateIndex
CREATE INDEX "MarksheetGradedSubject_marksheetId_idx" ON "MarksheetGradedSubject"("marksheetId");

-- CreateIndex
CREATE INDEX "MarksheetGradedScore_marksheetId_idx" ON "MarksheetGradedScore"("marksheetId");

-- CreateIndex
CREATE UNIQUE INDEX "MarksheetGradedScore_gradedSubjectId_studentId_key" ON "MarksheetGradedScore"("gradedSubjectId", "studentId");

-- CreateIndex
CREATE INDEX "MarksheetRemark_marksheetId_idx" ON "MarksheetRemark"("marksheetId");

-- CreateIndex
CREATE UNIQUE INDEX "MarksheetRemark_marksheetId_studentId_key" ON "MarksheetRemark"("marksheetId", "studentId");

-- AddForeignKey
ALTER TABLE "TeacherNote" ADD CONSTRAINT "TeacherNote_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherTask" ADD CONSTRAINT "TeacherTask_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_classTeacherId_fkey" FOREIGN KEY ("classTeacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionSubject" ADD CONSTRAINT "DivisionSubject_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionSubject" ADD CONSTRAINT "DivisionSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPromotionOutcome" ADD CONSTRAINT "StudentPromotionOutcome_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PromotionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentPromotionOutcome" ADD CONSTRAINT "StudentPromotionOutcome_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentRemark" ADD CONSTRAINT "StudentRemark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDayNote" ADD CONSTRAINT "AttendanceDayNote_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPostReaction" ADD CONSTRAINT "StaffPostReaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "StaffPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPostComment" ADD CONSTRAINT "StaffPostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "StaffPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusFeedPost" ADD CONSTRAINT "CampusFeedPost_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusFeedPost" ADD CONSTRAINT "CampusFeedPost_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionFeeStructure" ADD CONSTRAINT "DivisionFeeStructure_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFeePayment" ADD CONSTRAINT "StudentFeePayment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackboardFolder" ADD CONSTRAINT "BlackboardFolder_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackboardFolder" ADD CONSTRAINT "BlackboardFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "BlackboardFolder"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BlackboardMaterial" ADD CONSTRAINT "BlackboardMaterial_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackboardMaterial" ADD CONSTRAINT "BlackboardMaterial_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "BlackboardFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskContainer" ADD CONSTRAINT "TaskContainer_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskContainer" ADD CONSTRAINT "TaskContainer_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskContainer" ADD CONSTRAINT "TaskContainer_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskQuestion" ADD CONSTRAINT "TaskQuestion_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskQuestion" ADD CONSTRAINT "TaskQuestion_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskQuestion" ADD CONSTRAINT "TaskQuestion_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "TaskContainer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskModule" ADD CONSTRAINT "TaskModule_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskModule" ADD CONSTRAINT "TaskModule_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskModuleQuestion" ADD CONSTRAINT "TaskModuleQuestion_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "TaskModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskModuleQuestion" ADD CONSTRAINT "TaskModuleQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TaskQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTest" ADD CONSTRAINT "TaskTest_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTest" ADD CONSTRAINT "TaskTest_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTest" ADD CONSTRAINT "TaskTest_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTestQuestion" ADD CONSTRAINT "TaskTestQuestion_testId_fkey" FOREIGN KEY ("testId") REFERENCES "TaskTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTestQuestion" ADD CONSTRAINT "TaskTestQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TaskQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTestAttempt" ADD CONSTRAINT "TaskTestAttempt_testId_fkey" FOREIGN KEY ("testId") REFERENCES "TaskTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTestAttempt" ADD CONSTRAINT "TaskTestAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskStudentAnswer" ADD CONSTRAINT "TaskStudentAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "TaskTestAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskStudentAnswer" ADD CONSTRAINT "TaskStudentAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TaskQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPdfUpload" ADD CONSTRAINT "TaskPdfUpload_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionShareToken" ADD CONSTRAINT "QuestionShareToken_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignmentSubmission" ADD CONSTRAINT "TaskAssignmentSubmission_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "TaskAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignmentSubmission" ADD CONSTRAINT "TaskAssignmentSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskAssignmentSubmissionAttempt" ADD CONSTRAINT "TaskAssignmentSubmissionAttempt_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TaskAssignmentSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskAssignmentSubmissionAttempt" ADD CONSTRAINT "TaskAssignmentSubmissionAttempt_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "TaskAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskAssignmentSubmissionAttempt" ADD CONSTRAINT "TaskAssignmentSubmissionAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Marksheet" ADD CONSTRAINT "Marksheet_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Marksheet" ADD CONSTRAINT "Marksheet_createdByTeacherId_fkey" FOREIGN KEY ("createdByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetSubjectConfig" ADD CONSTRAINT "MarksheetSubjectConfig_marksheetId_fkey" FOREIGN KEY ("marksheetId") REFERENCES "Marksheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetSubjectConfig" ADD CONSTRAINT "MarksheetSubjectConfig_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetExamColumn" ADD CONSTRAINT "MarksheetExamColumn_marksheetId_fkey" FOREIGN KEY ("marksheetId") REFERENCES "Marksheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetExamColumn" ADD CONSTRAINT "MarksheetExamColumn_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetScore" ADD CONSTRAINT "MarksheetScore_marksheetId_fkey" FOREIGN KEY ("marksheetId") REFERENCES "Marksheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetScore" ADD CONSTRAINT "MarksheetScore_examColumnId_fkey" FOREIGN KEY ("examColumnId") REFERENCES "MarksheetExamColumn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetScore" ADD CONSTRAINT "MarksheetScore_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetGradedSubject" ADD CONSTRAINT "MarksheetGradedSubject_marksheetId_fkey" FOREIGN KEY ("marksheetId") REFERENCES "Marksheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetGradedScore" ADD CONSTRAINT "MarksheetGradedScore_marksheetId_fkey" FOREIGN KEY ("marksheetId") REFERENCES "Marksheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetGradedScore" ADD CONSTRAINT "MarksheetGradedScore_gradedSubjectId_fkey" FOREIGN KEY ("gradedSubjectId") REFERENCES "MarksheetGradedSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetGradedScore" ADD CONSTRAINT "MarksheetGradedScore_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetRemark" ADD CONSTRAINT "MarksheetRemark_marksheetId_fkey" FOREIGN KEY ("marksheetId") REFERENCES "Marksheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarksheetRemark" ADD CONSTRAINT "MarksheetRemark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "InventoryCategory" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventoryCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryCategory_institutionId_nameKey_key" ON "InventoryCategory"("institutionId", "nameKey");

CREATE TABLE "InventoryUnit" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "abbreviation" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventoryUnit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryUnit_institutionId_nameKey_key" ON "InventoryUnit"("institutionId", "nameKey");

CREATE TABLE "InventoryLocation" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryLocation_institutionId_nameKey_key" ON "InventoryLocation"("institutionId", "nameKey");

CREATE TABLE "InventorySupplier" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InventorySupplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventorySupplier_institutionId_nameKey_key" ON "InventorySupplier"("institutionId", "nameKey");

CREATE TYPE "InventoryItemType" AS ENUM ('CONSUMABLE', 'RETURNABLE', 'FIXED_ASSET');
CREATE TABLE "InventoryItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "institutionId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "type" "InventoryItemType" NOT NULL,
  "categoryId" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "lowStockLevel" DECIMAL(14,3) NOT NULL DEFAULT 0 CHECK ("lowStockLevel" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "InventoryStockBalance" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "institutionId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL CHECK ("quantity" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "InventoryStockMovement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "institutionId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL CHECK ("quantity" > 0),
  "recordedOn" DATE NOT NULL,
  "notes" TEXT NOT NULL DEFAULT '',
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "InventoryItem_institutionId_code_key" ON "InventoryItem"("institutionId", "code");
CREATE INDEX "InventoryItem_institutionId_name_idx" ON "InventoryItem"("institutionId", "name");
CREATE UNIQUE INDEX "InventoryStockBalance_itemId_locationId_key" ON "InventoryStockBalance"("itemId", "locationId");
CREATE INDEX "InventoryStockBalance_institutionId_idx" ON "InventoryStockBalance"("institutionId");
CREATE INDEX "InventoryStockMovement_institutionId_itemId_createdAt_idx" ON "InventoryStockMovement"("institutionId", "itemId", "createdAt");
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "InventoryCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "InventoryUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockBalance" ADD CONSTRAINT "InventoryStockBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockBalance" ADD CONSTRAINT "InventoryStockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryStockMovement" ADD COLUMN "previousQuantity" DECIMAL(14,3), ADD COLUMN "correctedQuantity" DECIMAL(14,3);
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_correction_values_check" CHECK ("kind" <> 'OPENING_CORRECTION' OR ("previousQuantity" IS NOT NULL AND "previousQuantity" >= 0 AND "correctedQuantity" IS NOT NULL AND "correctedQuantity" >= 0 AND "quantity" = ABS("correctedQuantity" - "previousQuantity")));
ALTER TABLE "InventoryStockMovement" ADD COLUMN "supplierId" TEXT, ADD COLUMN "supplierName" TEXT NOT NULL DEFAULT '', ADD COLUMN "billNumber" TEXT NOT NULL DEFAULT '', ADD COLUMN "billDate" DATE, ADD COLUMN "totalCost" DECIMAL(14,2), ADD COLUMN "requestId" TEXT;
CREATE UNIQUE INDEX "InventoryStockMovement_institutionId_requestId_key" ON "InventoryStockMovement"("institutionId", "requestId");
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "InventorySupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_receipt_check" CHECK ("kind" <> 'RECEIPT' OR ("supplierId" IS NOT NULL AND "requestId" IS NOT NULL AND ("totalCost" IS NULL OR "totalCost" >= 0)));
ALTER TABLE "InventoryStockMovement" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "InventoryStockMovement" ADD COLUMN "issuedToType" TEXT, ADD COLUMN "issuedToName" TEXT NOT NULL DEFAULT '', ADD COLUMN "dueOn" DATE, ADD COLUMN "returnExpected" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "issueId" TEXT;
CREATE INDEX "InventoryStockMovement_issueId_idx" ON "InventoryStockMovement"("issueId");
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "InventoryStockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_issue_details_check" CHECK ("kind" <> 'ISSUE' OR ("requestId" IS NOT NULL AND "issuedToType" IS NOT NULL AND "issuedToType" IN ('TEACHER', 'CLASSROOM', 'DEPARTMENT') AND length(trim("issuedToName")) > 0 AND ("dueOn" IS NULL OR ("returnExpected" AND "dueOn" >= "recordedOn"))));
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_return_details_check" CHECK (("kind" = 'RETURN' AND "issueId" IS NOT NULL AND "requestId" IS NOT NULL) OR ("kind" <> 'RETURN' AND "issueId" IS NULL));

ALTER TABLE "InventoryStockMovement" ADD COLUMN "issuedToLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "InventoryStockMovement" DROP CONSTRAINT "InventoryStockMovement_issue_details_check";
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_issue_details_check" CHECK ("kind" <> 'ISSUE' OR ("requestId" IS NOT NULL AND "issuedToType" IS NOT NULL AND "issuedToType" IN ('PRINCIPAL', 'VICE_PRINCIPAL', 'HEAD_MASTER', 'HEAD_MISTRESS', 'DIRECTOR', 'ADMINISTRATOR', 'COORDINATOR', 'DEAN', 'RECTOR', 'SUPERINTENDENT', 'CHAIRMAN', 'SECRETARY', 'TRUSTEE', 'TEACHER', 'STUDENT', 'LIBRARIAN', 'ACCOUNTANT', 'CLERK', 'RECEPTIONIST', 'LAB_ASSISTANT', 'SPORTS_COACH', 'IT_STAFF', 'PEON', 'DRIVER', 'SECURITY_GUARD', 'HOUSEKEEPING', 'CLASSROOM', 'DEPARTMENT', 'CUSTOM') AND length(trim("issuedToName")) > 0 AND (("issuedToType" = 'CUSTOM' AND length(trim("issuedToLabel")) > 0) OR ("issuedToType" <> 'CUSTOM' AND "issuedToLabel" = '')) AND ("dueOn" IS NULL OR ("returnExpected" AND "dueOn" >= "recordedOn"))));

ALTER TABLE "InventoryStockMovement" ADD COLUMN "transferId" TEXT, ADD COLUMN "transferLocationId" TEXT, ADD COLUMN "transferLocationName" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX "InventoryStockMovement_transferId_kind_key" ON "InventoryStockMovement"("transferId", "kind");
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_transferLocationId_fkey" FOREIGN KEY ("transferLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_transfer_details_check" CHECK (("kind" IN ('TRANSFER_OUT', 'TRANSFER_IN') AND "transferId" IS NOT NULL AND "transferLocationId" IS NOT NULL AND "transferLocationId" <> "locationId" AND length(trim("transferLocationName")) > 0 AND (("kind" = 'TRANSFER_OUT' AND "requestId" IS NOT NULL) OR ("kind" = 'TRANSFER_IN' AND "requestId" IS NULL))) OR ("kind" NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') AND "transferId" IS NULL AND "transferLocationId" IS NULL));

ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_adjustment_values_check" CHECK ("kind" <> 'ADJUSTMENT' OR ("requestId" IS NOT NULL AND "previousQuantity" IS NOT NULL AND "correctedQuantity" IS NOT NULL AND "previousQuantity" >= 0 AND "correctedQuantity" >= 0 AND "quantity" = abs("correctedQuantity" - "previousQuantity") AND length(trim("notes")) > 0));

ALTER TABLE "InventoryStockMovement" ADD COLUMN "deliveredQuantity" DECIMAL(14,3), ADD COLUMN "rejectedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN "damageReason" TEXT NOT NULL DEFAULT '';
UPDATE "InventoryStockMovement" SET "deliveredQuantity" = "quantity" WHERE "kind" = 'RECEIPT';
ALTER TABLE "InventoryStockMovement" DROP CONSTRAINT "InventoryStockMovement_quantity_check";
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_quantity_check" CHECK ("quantity" > 0 OR ("kind" = 'RECEIPT' AND "quantity" = 0));
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_receipt_acceptance_check" CHECK ("kind" <> 'RECEIPT' OR ("deliveredQuantity" IS NOT NULL AND "deliveredQuantity" > 0 AND "rejectedQuantity" >= 0 AND "rejectedQuantity" <= "deliveredQuantity" AND "quantity" = "deliveredQuantity" - "rejectedQuantity" AND (("rejectedQuantity" = 0 AND "damageReason" = '') OR ("rejectedQuantity" > 0 AND length(trim("damageReason")) > 0))));

ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_supplier_return_check" CHECK ("kind" <> 'SUPPLIER_RETURN' OR ("supplierId" IS NOT NULL AND length(trim("supplierName")) > 0 AND "requestId" IS NOT NULL AND length(trim("notes")) > 0));

ALTER TABLE "InventoryStockMovement" ADD COLUMN "adjustmentType" TEXT;
UPDATE "InventoryStockMovement" SET "adjustmentType" = 'COUNT_CORRECTION' WHERE "kind" = 'ADJUSTMENT';
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_adjustment_type_check" CHECK ("kind" <> 'ADJUSTMENT' OR ("adjustmentType" IS NOT NULL AND "adjustmentType" IN ('COUNT_CORRECTION', 'DAMAGED', 'LOST') AND ("adjustmentType" = 'COUNT_CORRECTION' OR "correctedQuantity" < "previousQuantity")));

ALTER TABLE "InventoryStockMovement" DROP CONSTRAINT "InventoryStockMovement_return_details_check";
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_return_details_check" CHECK (("kind" IN ('RETURN','ISSUE_DAMAGED','ISSUE_LOST') AND "issueId" IS NOT NULL AND "requestId" IS NOT NULL) OR ("kind" NOT IN ('RETURN','ISSUE_DAMAGED','ISSUE_LOST') AND "issueId" IS NULL));
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_issue_resolution_reason_check" CHECK ("kind" NOT IN ('ISSUE_DAMAGED','ISSUE_LOST') OR length(trim("notes")) > 0);

CREATE TABLE "InventoryPurchaseRequest" (
 "id" TEXT NOT NULL PRIMARY KEY, "institutionId" TEXT NOT NULL,
 "requestId" TEXT NOT NULL, "source" TEXT NOT NULL DEFAULT 'MANUAL',
 "requestedById" TEXT, "requestedByName" TEXT NOT NULL, "department" TEXT NOT NULL DEFAULT '',
 "reason" TEXT NOT NULL, "requiredOn" DATE NOT NULL, "lines" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
 "createdById" TEXT NOT NULL, "events" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "InventoryPurchaseRequest_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED')),
 CONSTRAINT "InventoryPurchaseRequest_source_check" CHECK ("source" IN ('MANUAL','TEACHER')),
 CONSTRAINT "InventoryPurchaseRequest_details_check" CHECK (length(trim("requestedByName")) > 0 AND length(trim("reason")) > 0 AND "revision" > 0 AND jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 20)
);
CREATE UNIQUE INDEX "InventoryPurchaseRequest_institutionId_requestId_key" ON "InventoryPurchaseRequest"("institutionId", "requestId");
CREATE INDEX "InventoryPurchaseRequest_institutionId_createdAt_idx" ON "InventoryPurchaseRequest"("institutionId", "createdAt");

CREATE TABLE "InventoryPurchaseOrder" (
 "id" TEXT PRIMARY KEY, "institutionId" TEXT NOT NULL, "purchaseRequestId" TEXT NOT NULL,
 "number" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "supplierSnapshot" JSONB NOT NULL,
 "locationId" TEXT NOT NULL, "locationName" TEXT NOT NULL, "expectedOn" DATE NOT NULL,
 "instructions" TEXT NOT NULL DEFAULT '', "lines" JSONB NOT NULL, "total" DECIMAL(14,2) NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
 "createdById" TEXT NOT NULL, "events" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "InventoryPurchaseOrder_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "InventoryPurchaseRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "InventoryPurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "InventorySupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "InventoryPurchaseOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "InventoryPurchaseOrder_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','PARTIALLY_RECEIVED','COMPLETED','CLOSED')),
 CONSTRAINT "InventoryPurchaseOrder_total_check" CHECK ("total" >= 0 AND "total" <= 1000000000 AND "revision" > 0 AND jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 20)
);
CREATE UNIQUE INDEX "InventoryPurchaseOrder_purchaseRequestId_key" ON "InventoryPurchaseOrder"("purchaseRequestId");
CREATE UNIQUE INDEX "InventoryPurchaseOrder_institutionId_number_key" ON "InventoryPurchaseOrder"("institutionId", "number");
CREATE INDEX "InventoryPurchaseOrder_institutionId_createdAt_idx" ON "InventoryPurchaseOrder"("institutionId", "createdAt");
ALTER TABLE "InventoryStockMovement" ADD COLUMN "purchaseOrderId" TEXT, ADD COLUMN "purchaseOrderLine" INTEGER;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "InventoryPurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockMovement" ADD CONSTRAINT "InventoryStockMovement_purchaseOrder_check" CHECK (("purchaseOrderId" IS NULL AND "purchaseOrderLine" IS NULL) OR ("purchaseOrderId" IS NOT NULL AND "purchaseOrderLine" >= 0 AND "purchaseOrderLine" IS NOT NULL AND "kind" = 'RECEIPT'));
CREATE INDEX "InventoryStockMovement_purchaseOrderId_idx" ON "InventoryStockMovement"("purchaseOrderId");

CREATE TABLE "InventorySetupOrder" (
 "institutionId" TEXT NOT NULL, "kind" TEXT NOT NULL, "ids" JSONB NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "InventorySetupOrder_pkey" PRIMARY KEY ("institutionId", "kind"),
 CONSTRAINT "InventorySetupOrder_kind_check" CHECK ("kind" IN ('categories','units','locations','suppliers')),
 CONSTRAINT "InventorySetupOrder_details_check" CHECK (jsonb_typeof("ids") = 'array' AND "revision" > 0)
);

-- Ledger time, correction audit and fulfilment states
ALTER TABLE "InventoryStockMovement" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMPTZ(3);
ALTER TABLE "InventoryStockMovement" ADD COLUMN IF NOT EXISTS "corrections" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "InventoryPurchaseRequest" DROP CONSTRAINT IF EXISTS "InventoryPurchaseRequest_status_check";
ALTER TABLE "InventoryPurchaseRequest" ADD CONSTRAINT "InventoryPurchaseRequest_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED','PARTIALLY_ISSUED','ISSUED'));
ALTER TABLE "InventoryPurchaseRequest" DROP CONSTRAINT IF EXISTS "InventoryPurchaseRequest_source_check";
ALTER TABLE "InventoryPurchaseRequest" ADD CONSTRAINT "InventoryPurchaseRequest_source_check" CHECK ("source" IN ('MANUAL','TEACHER','ITEM_REQUEST_PURCHASE'));
