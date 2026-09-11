-- CreateTable: Staff
CREATE TABLE IF NOT EXISTS "Staff" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "designation" TEXT,
    "staffType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Staff_userId_key" ON "Staff"("userId");
CREATE INDEX IF NOT EXISTS "Staff_institutionId_idx" ON "Staff"("institutionId");

-- CreateTable: StaffSalaryStructure
CREATE TABLE IF NOT EXISTS "StaffSalaryStructure" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "templateId" TEXT,
    "earnings" JSONB NOT NULL,
    "deductions" JSONB NOT NULL,
    "bankDetails" JSONB,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffSalaryStructure_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StaffSalaryStructure_staffId_key" ON "StaffSalaryStructure"("staffId");
CREATE INDEX IF NOT EXISTS "StaffSalaryStructure_institutionId_idx" ON "StaffSalaryStructure"("institutionId");

-- Backfill: one Staff row per existing Teacher
INSERT INTO "Staff" ("id", "institutionId", "name", "email", "designation", "staffType", "status", "joinedAt", "userId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), t."institutionId", COALESCE(u."name", 'Unknown'), u."email", t."title", 'TEACHER', 'ACTIVE', t."joinedAt", t."userId", now(), now()
FROM "Teacher" t
JOIN "User" u ON u."id" = t."userId"
WHERE NOT EXISTS (SELECT 1 FROM "Staff" s WHERE s."userId" = t."userId");

-- Backfill: StaffSalaryStructure from existing TeacherSalaryStructure, joined through Teacher.userId -> Staff.userId
INSERT INTO "StaffSalaryStructure" ("id", "staffId", "institutionId", "templateId", "earnings", "deductions", "bankDetails", "effectiveFrom", "createdAt", "updatedAt")
SELECT gen_random_uuid(), s."id", tss."institutionId", tss."templateId", tss."earnings", tss."deductions", tss."bankDetails", tss."effectiveFrom", tss."createdAt", tss."updatedAt"
FROM "TeacherSalaryStructure" tss
JOIN "Teacher" t ON t."id" = tss."teacherId"
JOIN "Staff" s ON s."userId" = t."userId";

-- AlterTable: Payslip — add staffId/staffName/staffEmail, drop teacherId
ALTER TABLE "Payslip" ADD COLUMN IF NOT EXISTS "staffId" TEXT;
ALTER TABLE "Payslip" ADD COLUMN IF NOT EXISTS "staffName" TEXT;
ALTER TABLE "Payslip" ADD COLUMN IF NOT EXISTS "staffEmail" TEXT;

-- Backfill (no-op today — zero Payslip rows exist — but correct if any ever do before this runs)
UPDATE "Payslip" p
SET "staffId" = s."id", "staffName" = s."name", "staffEmail" = s."email"
FROM "Staff" s, "Teacher" t
WHERE p."teacherId" = t."id" AND t."userId" = s."userId" AND p."staffId" IS NULL;

ALTER TABLE "Payslip" DROP CONSTRAINT IF EXISTS "Payslip_teacherId_fkey";
DROP INDEX IF EXISTS "Payslip_payrollRunId_teacherId_key";
DROP INDEX IF EXISTS "Payslip_teacherId_idx";
ALTER TABLE "Payslip" DROP COLUMN IF EXISTS "teacherId";

ALTER TABLE "Payslip" ALTER COLUMN "staffId" SET NOT NULL;
ALTER TABLE "Payslip" ALTER COLUMN "staffName" SET NOT NULL;
ALTER TABLE "Payslip" ALTER COLUMN "staffEmail" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Payslip_payrollRunId_staffId_key" ON "Payslip"("payrollRunId", "staffId");
CREATE INDEX IF NOT EXISTS "Payslip_staffId_idx" ON "Payslip"("staffId");

-- Drop the old teacher-only salary structure table (fully superseded by StaffSalaryStructure)
DROP TABLE IF EXISTS "TeacherSalaryStructure";

-- AddForeignKeys
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DO $$ BEGIN
  ALTER TABLE "Staff" ADD CONSTRAINT "Staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "StaffSalaryStructure" ADD CONSTRAINT "StaffSalaryStructure_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffSalaryStructure" ADD CONSTRAINT "StaffSalaryStructure_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
