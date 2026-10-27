-- AI Timetable chat history and saved timetable versions (BYOD tenant). Mirrors TimetableAiMessage + TimetableVersion.
CREATE TABLE IF NOT EXISTS "TimetableAiMessage" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "data" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TimetableAiMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TimetableAiMessage_institutionId_academicYearId_createdAt_idx" ON "TimetableAiMessage"("institutionId", "academicYearId", "createdAt");

CREATE TABLE IF NOT EXISTS "TimetableVersion" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "entries" JSONB NOT NULL,
  "periods" INTEGER NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimetableVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TimetableVersion_institutionId_academicYearId_createdAt_idx" ON "TimetableVersion"("institutionId", "academicYearId", "createdAt");
