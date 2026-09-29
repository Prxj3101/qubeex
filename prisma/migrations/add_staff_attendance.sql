-- Staff attendance (Phase 1). Adds only these tables / columns; touches nothing else.
-- Run: npx prisma db execute --file prisma/migrations/add_staff_attendance.sql

ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "machineId" TEXT;

ALTER TABLE "Payslip" ADD COLUMN IF NOT EXISTS "lopSource" TEXT;
ALTER TABLE "Payslip" ADD COLUMN IF NOT EXISTS "attendanceSummary" JSONB;

ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "attendanceLop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "officeStart" TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "graceMinutes" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "halfDayMinutes" INTEGER NOT NULL DEFAULT 240;
ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "weeklyOffDays" JSONB;
ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "offSaturdays" JSONB;
ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "lateRuleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PayrollSettings" ADD COLUMN IF NOT EXISTS "lateRuleCount" INTEGER NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS "StaffAttendance" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "checkIn" TEXT,
  "checkOut" TEXT,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "note" TEXT,
  "markedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffAttendance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StaffAttendance_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "StaffAttendance_staffId_date_key" ON "StaffAttendance"("staffId", "date");
CREATE INDEX IF NOT EXISTS "StaffAttendance_institutionId_date_idx" ON "StaffAttendance"("institutionId", "date");

CREATE TABLE IF NOT EXISTS "StaffPunch" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "time" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'IMPORT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffPunch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StaffPunch_institutionId_machineId_date_time_key" ON "StaffPunch"("institutionId", "machineId", "date", "time");
CREATE INDEX IF NOT EXISTS "StaffPunch_institutionId_date_idx" ON "StaffPunch"("institutionId", "date");
