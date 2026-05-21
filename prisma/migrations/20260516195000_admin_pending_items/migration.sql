-- Add STUDENT role and student profile support
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'STUDENT';

DO $$ BEGIN
  CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "Student" (
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
  "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Student_userId_key" ON "Student"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "Student_studentId_institutionId_key" ON "Student"("studentId", "institutionId");
CREATE INDEX IF NOT EXISTS "Student_institutionId_idx" ON "Student"("institutionId");

DO $$ BEGIN
  ALTER TABLE "Student" ADD CONSTRAINT "Student_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Student" ADD CONSTRAINT "Student_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Student" ADD CONSTRAINT "Student_standardId_fkey"
  FOREIGN KEY ("standardId") REFERENCES "Standard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Student" ADD CONSTRAINT "Student_divisionId_fkey"
  FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Notification recipient read/dismiss state
ALTER TABLE "NotificationRecipient"
  ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dismissedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "NotificationRecipient_institutionId_readAt_idx"
  ON "NotificationRecipient"("institutionId", "readAt");

CREATE INDEX IF NOT EXISTS "NotificationRecipient_institutionId_dismissedAt_idx"
  ON "NotificationRecipient"("institutionId", "dismissedAt");
