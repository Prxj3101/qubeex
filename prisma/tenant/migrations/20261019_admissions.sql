-- Admissions (BYOD tenant). Mirrors AdmissionSettings + AdmissionApplication in prisma/schema.prisma.
CREATE TABLE IF NOT EXISTS "AdmissionSettings" (
 "id" TEXT NOT NULL PRIMARY KEY, "institutionId" TEXT NOT NULL, "academicYearId" TEXT,
 "formOpen" BOOLEAN NOT NULL DEFAULT false, "interactionStep" BOOLEAN NOT NULL DEFAULT true,
 "registrationFee" DECIMAL(12,2), "admissionFeeDays" INTEGER NOT NULL DEFAULT 7,
 "ageCutoff" TEXT NOT NULL DEFAULT '06-01', "ageRules" JSONB NOT NULL DEFAULT '[]',
 "fields" JSONB NOT NULL DEFAULT '{}', "questions" JSONB NOT NULL DEFAULT '[]', "documents" JSONB NOT NULL DEFAULT '[]',
 "admissionNoPrefix" TEXT NOT NULL DEFAULT '', "nextAdmissionNo" INTEGER NOT NULL DEFAULT 1,
 "nextApplicationNo" INTEGER NOT NULL DEFAULT 1, "revision" INTEGER NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdmissionSettings_institutionId_key" ON "AdmissionSettings"("institutionId");

CREATE TABLE IF NOT EXISTS "AdmissionApplication" (
 "id" TEXT NOT NULL PRIMARY KEY, "institutionId" TEXT NOT NULL, "academicYearId" TEXT NOT NULL,
 "applicationNo" TEXT NOT NULL, "standardId" TEXT NOT NULL, "stage" TEXT NOT NULL DEFAULT 'ENQUIRY',
 "outcome" TEXT, "waitlistRank" INTEGER, "source" TEXT NOT NULL DEFAULT 'COUNTER',
 "childName" TEXT NOT NULL, "dob" TEXT, "gender" TEXT, "parentName" TEXT NOT NULL DEFAULT '',
 "phoneLast4" TEXT NOT NULL DEFAULT '', "details" TEXT NOT NULL,
 "registrationFee" JSONB, "interaction" JSONB, "offer" JSONB, "admissionFee" JSONB,
 "documents" JSONB NOT NULL DEFAULT '[]', "admissionNo" TEXT, "divisionId" TEXT, "studentId" TEXT,
 "statusToken" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1, "events" JSONB NOT NULL DEFAULT '[]',
 "createdById" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdmissionApplication_statusToken_key" ON "AdmissionApplication"("statusToken");
CREATE UNIQUE INDEX IF NOT EXISTS "AdmissionApplication_institutionId_applicationNo_key" ON "AdmissionApplication"("institutionId", "applicationNo");
CREATE UNIQUE INDEX IF NOT EXISTS "AdmissionApplication_institutionId_admissionNo_key" ON "AdmissionApplication"("institutionId", "admissionNo");
CREATE INDEX IF NOT EXISTS "AdmissionApplication_institutionId_academicYearId_stage_idx" ON "AdmissionApplication"("institutionId", "academicYearId", "stage");
