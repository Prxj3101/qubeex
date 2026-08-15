-- CreateTable
CREATE TABLE IF NOT EXISTS "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "teacherId" TEXT,
    "userId" TEXT NOT NULL,
    "userRole" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiUsageEvent_institutionId_createdAt_idx" ON "AiUsageEvent"("institutionId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsageEvent_teacherId_createdAt_idx" ON "AiUsageEvent"("teacherId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsageEvent_institutionId_feature_createdAt_idx" ON "AiUsageEvent"("institutionId", "feature", "createdAt");

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN IF NOT EXISTS "aiSoftLimitTokens" INTEGER;
