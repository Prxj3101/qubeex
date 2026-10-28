CREATE TABLE "ParentForm" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "institutionId" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "title" TEXT NOT NULL,
 "description" TEXT,
 "options" JSONB NOT NULL,
 "allowComment" BOOLEAN NOT NULL DEFAULT true,
 "deadline" TIMESTAMP(3),
 "closedAt" TIMESTAMP(3),
 "allDivisions" BOOLEAN NOT NULL DEFAULT false,
 "createdByUserId" TEXT NOT NULL,
 "createdByRole" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ParentForm_institutionId_createdAt_idx" ON "ParentForm"("institutionId", "createdAt");
CREATE INDEX "ParentForm_institutionId_createdByUserId_idx" ON "ParentForm"("institutionId", "createdByUserId");

CREATE TABLE "ParentFormTarget" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "institutionId" TEXT NOT NULL,
 "formId" TEXT NOT NULL,
 "divisionId" TEXT NOT NULL,
 CONSTRAINT "ParentFormTarget_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ParentForm"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "ParentFormTarget_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ParentFormTarget_formId_divisionId_key" ON "ParentFormTarget"("formId", "divisionId");
CREATE INDEX "ParentFormTarget_divisionId_idx" ON "ParentFormTarget"("divisionId");

CREATE TABLE "ParentFormResponse" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "institutionId" TEXT NOT NULL,
 "formId" TEXT NOT NULL,
 "studentId" TEXT NOT NULL,
 "optionIndex" INTEGER NOT NULL,
 "comment" TEXT,
 "history" JSONB NOT NULL,
 "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ParentFormResponse_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ParentForm"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "ParentFormResponse_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ParentFormResponse_formId_studentId_key" ON "ParentFormResponse"("formId", "studentId");
CREATE INDEX "ParentFormResponse_studentId_idx" ON "ParentFormResponse"("studentId");

CREATE TABLE "PtmSession" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "institutionId" TEXT NOT NULL,
 "teacherId" TEXT NOT NULL,
 "title" TEXT NOT NULL,
 "date" DATE NOT NULL,
 "startMinute" INTEGER NOT NULL,
 "endMinute" INTEGER NOT NULL,
 "slotMinutes" INTEGER NOT NULL,
 "location" TEXT,
 "note" TEXT,
 "cancelledAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PtmSession_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PtmSession_institutionId_date_idx" ON "PtmSession"("institutionId", "date");
CREATE INDEX "PtmSession_teacherId_date_idx" ON "PtmSession"("teacherId", "date");

CREATE TABLE "PtmSlot" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "institutionId" TEXT NOT NULL,
 "sessionId" TEXT NOT NULL,
 "startMinute" INTEGER NOT NULL,
 "endMinute" INTEGER NOT NULL,
 "studentId" TEXT,
 "bookedByUserId" TEXT,
 "bookedAt" TIMESTAMP(3),
 CONSTRAINT "PtmSlot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PtmSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "PtmSlot_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PtmSlot_sessionId_startMinute_key" ON "PtmSlot"("sessionId", "startMinute");
CREATE UNIQUE INDEX "PtmSlot_sessionId_studentId_key" ON "PtmSlot"("sessionId", "studentId");
CREATE INDEX "PtmSlot_studentId_idx" ON "PtmSlot"("studentId");
