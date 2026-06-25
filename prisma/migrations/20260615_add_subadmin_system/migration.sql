-- Add SUB_ADMIN to the Role enum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUB_ADMIN';

-- Add permissions column to Invite table
ALTER TABLE "Invite" ADD COLUMN "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Create SubAdmin table
CREATE TABLE IF NOT EXISTS "SubAdmin" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubAdmin_pkey" PRIMARY KEY ("id")
);

-- Create unique index on userId
CREATE UNIQUE INDEX "SubAdmin_userId_key" ON "SubAdmin"("userId");

-- Add foreign key from SubAdmin to User
ALTER TABLE "SubAdmin" ADD CONSTRAINT "SubAdmin_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add foreign key from SubAdmin to Institution
ALTER TABLE "SubAdmin" ADD CONSTRAINT "SubAdmin_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add institutionId index
CREATE INDEX IF NOT EXISTS "SubAdmin_institutionId_idx" ON "SubAdmin"("institutionId");
