ALTER TABLE "ParentChatMessage"
 ADD COLUMN "attachmentUrl" TEXT,
 ADD COLUMN "attachmentType" TEXT,
 ADD COLUMN "attachmentName" TEXT,
 ADD COLUMN "reportedAt" TIMESTAMP(3),
 ADD COLUMN "reportedByUserId" TEXT,
 ADD COLUMN "reportReason" TEXT;
CREATE INDEX "ParentChatMessage_institutionId_reportedAt_idx" ON "ParentChatMessage"("institutionId", "reportedAt");
