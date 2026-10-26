CREATE TABLE "ParentChatSettings" (
 "institutionId" TEXT NOT NULL PRIMARY KEY,
 "enabled" BOOLEAN NOT NULL DEFAULT true,
 "officeStart" TEXT NOT NULL DEFAULT '08:00',
 "officeEnd" TEXT NOT NULL DEFAULT '18:00',
 "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ParentChatThread" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "institutionId" TEXT NOT NULL,
 "studentId" TEXT NOT NULL,
 "teacherId" TEXT NOT NULL,
 "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ParentChatThread_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "ParentChatThread_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ParentChatThread_studentId_teacherId_key" ON "ParentChatThread"("studentId", "teacherId");
CREATE INDEX "ParentChatThread_institutionId_lastMessageAt_idx" ON "ParentChatThread"("institutionId", "lastMessageAt");
CREATE INDEX "ParentChatThread_teacherId_lastMessageAt_idx" ON "ParentChatThread"("teacherId", "lastMessageAt");

CREATE TABLE "ParentChatMessage" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "institutionId" TEXT NOT NULL,
 "threadId" TEXT NOT NULL,
 "fromTeacher" BOOLEAN NOT NULL,
 "senderUserId" TEXT NOT NULL,
 "text" TEXT NOT NULL,
 "readAt" TIMESTAMP(3),
 "hiddenAt" TIMESTAMP(3),
 "hiddenByUserId" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ParentChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ParentChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ParentChatMessage_threadId_createdAt_idx" ON "ParentChatMessage"("threadId", "createdAt");
CREATE INDEX "ParentChatMessage_institutionId_idx" ON "ParentChatMessage"("institutionId");
