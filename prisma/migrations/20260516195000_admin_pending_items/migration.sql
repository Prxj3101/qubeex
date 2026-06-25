-- Add TEACHER and STUDENT roles
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TEACHER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'STUDENT';

DO $$ BEGIN
  CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Campus structure: Standard → Division → Subject → DivisionAssignment

CREATE TABLE IF NOT EXISTS "Standard" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Standard_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Standard_institutionId_idx" ON "Standard"("institutionId");

DO $$ BEGIN
  ALTER TABLE "Standard" ADD CONSTRAINT "Standard_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "Division" (
  "id" TEXT NOT NULL,
  "standardId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "capacity" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Division_institutionId_idx" ON "Division"("institutionId");
CREATE INDEX IF NOT EXISTS "Division_standardId_idx" ON "Division"("standardId");

DO $$ BEGIN
  ALTER TABLE "Division" ADD CONSTRAINT "Division_standardId_fkey"
  FOREIGN KEY ("standardId") REFERENCES "Standard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Division" ADD CONSTRAINT "Division_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "Subject" (
  "id" TEXT NOT NULL,
  "divisionId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "color" TEXT,
  "order" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Subject_divisionId_idx" ON "Subject"("divisionId");
CREATE INDEX IF NOT EXISTS "Subject_institutionId_idx" ON "Subject"("institutionId");

DO $$ BEGIN
  ALTER TABLE "Subject" ADD CONSTRAINT "Subject_divisionId_fkey"
  FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "Subject" ADD CONSTRAINT "Subject_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "DivisionAssignment" (
  "id" TEXT NOT NULL,
  "divisionId" TEXT NOT NULL,
  "subjectId" TEXT,
  "teacherId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DivisionAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DivisionAssignment_divisionId_idx" ON "DivisionAssignment"("divisionId");
CREATE INDEX IF NOT EXISTS "DivisionAssignment_teacherId_idx" ON "DivisionAssignment"("teacherId");
CREATE INDEX IF NOT EXISTS "DivisionAssignment_institutionId_idx" ON "DivisionAssignment"("institutionId");

DO $$ BEGIN
  ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_divisionId_fkey"
  FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Student profile

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
