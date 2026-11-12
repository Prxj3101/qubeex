-- Fees desk reminders log (BYOD tenant). Mirrors FeeReminder.
CREATE TABLE IF NOT EXISTS "FeeReminder" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "lang" TEXT NOT NULL DEFAULT 'en',
  "sentTo" TEXT,
  "amount" INTEGER NOT NULL DEFAULT 0,
  "sentById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeeReminder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FeeReminder_institutionId_academicYearId_studentId_idx" ON "FeeReminder"("institutionId", "academicYearId", "studentId");
