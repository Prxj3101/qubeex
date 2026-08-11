-- Baseline migration for the "StudentRemark" table and its enums.
-- Same situation as the DivisionFeeStructure/StudentFeePayment baselines
-- added just before this one: this table (and its RemarkCardType /
-- RemarkSeverity / RemarkStatus enums) already exist on the real database
-- but were never captured by a migration, which breaks the shadow-database
-- replay used by `migrate dev`. This migration is inserted before
-- 20260805100000_remark_multi_attachments and marked as already-applied on
-- the real database via `prisma migrate resolve --applied` (not actually run
-- against it, since the table already exists there).
--
-- Includes the original single-attachment columns (attachmentUrl /
-- attachmentType / attachmentName) since 20260805100000 converts those into
-- the "attachments" JSON array and drops them.
CREATE TYPE "RemarkCardType" AS ENUM ('YELLOW', 'RED');

CREATE TYPE "RemarkSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE "RemarkStatus" AS ENUM ('ACTIVE', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED', 'APPEALED');

CREATE TABLE IF NOT EXISTS "StudentRemark" (
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
    "attachmentUrl" TEXT,
    "attachmentType" TEXT,
    "attachmentName" TEXT,
    "reportedByUserId" TEXT NOT NULL,
    "reportedByRole" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "reviewRemark" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentRemark_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StudentRemark_studentId_idx" ON "StudentRemark"("studentId");

CREATE INDEX IF NOT EXISTS "StudentRemark_institutionId_idx" ON "StudentRemark"("institutionId");

CREATE INDEX IF NOT EXISTS "StudentRemark_assignedToUserId_status_idx" ON "StudentRemark"("assignedToUserId", "status");

ALTER TABLE "StudentRemark" ADD CONSTRAINT "StudentRemark_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StudentRemark" ADD CONSTRAINT "StudentRemark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StudentRemark" ADD CONSTRAINT "StudentRemark_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StudentRemark" ADD CONSTRAINT "StudentRemark_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StudentRemark" ADD CONSTRAINT "StudentRemark_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
