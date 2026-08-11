-- Baseline migration for the "StudentFeePayment" table.
-- Same situation as the DivisionFeeStructure baseline added just before this
-- one: this table already exists on the real database but was never
-- captured by a CREATE TABLE migration, which breaks the shadow-database
-- replay used by `migrate dev`. This migration is inserted before
-- 20260803160000_add_fee_payment_remark and marked as already-applied on the
-- real database via `prisma migrate resolve --applied` (not actually run
-- against it, since the table is already there).
CREATE TABLE IF NOT EXISTS "StudentFeePayment" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "feeMonthId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentFeePayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StudentFeePayment_studentId_feeMonthId_key" ON "StudentFeePayment"("studentId", "feeMonthId");

CREATE INDEX IF NOT EXISTS "StudentFeePayment_institutionId_idx" ON "StudentFeePayment"("institutionId");

ALTER TABLE "StudentFeePayment" ADD CONSTRAINT "StudentFeePayment_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StudentFeePayment" ADD CONSTRAINT "StudentFeePayment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
