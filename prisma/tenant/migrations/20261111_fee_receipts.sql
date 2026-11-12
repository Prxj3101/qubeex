-- Fees desk receipts (BYOD tenant). Mirrors FeeReceipt.
CREATE TABLE IF NOT EXISTS "FeeReceipt" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "divisionId" TEXT,
  "number" INTEGER NOT NULL,
  "receiptNo" TEXT NOT NULL,
  "lines" JSONB NOT NULL,
  "amount" INTEGER NOT NULL,
  "discount" INTEGER NOT NULL DEFAULT 0,
  "mode" TEXT NOT NULL,
  "reference" TEXT,
  "note" TEXT,
  "day" TEXT NOT NULL,
  "collectedById" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancelledById" TEXT,
  "cancelReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeeReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FeeReceipt_institutionId_academicYearId_number_key" ON "FeeReceipt"("institutionId", "academicYearId", "number");
CREATE INDEX IF NOT EXISTS "FeeReceipt_institutionId_day_idx" ON "FeeReceipt"("institutionId", "day");
CREATE INDEX IF NOT EXISTS "FeeReceipt_institutionId_studentId_idx" ON "FeeReceipt"("institutionId", "studentId");
