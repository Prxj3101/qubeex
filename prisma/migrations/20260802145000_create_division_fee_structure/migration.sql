-- Baseline migration for the "DivisionFeeStructure" table.
-- This table already exists on the real database (it was created directly
-- against the DB at some point without ever generating a migration for it),
-- which is why "migrate dev" fails when it replays history from scratch into
-- a fresh shadow database: the later migration
-- 20260802150000_add_fee_card_fields tries to ALTER a table that, as far as
-- the migration history is concerned, was never created.
--
-- This migration is inserted before that one and marked as already-applied
-- on the real database via `prisma migrate resolve --applied` (it is NOT
-- run against the real DB, since the table is already there) - it only
-- exists so the shadow database replay (used by `migrate dev`) has a
-- consistent history to work from.
CREATE TABLE IF NOT EXISTS "DivisionFeeStructure" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "feeStructures" JSONB NOT NULL,
    "feeMonths" JSONB NOT NULL,
    "bankDetails" JSONB,
    "qrImageUrl" TEXT,
    "extraColumns" JSONB NOT NULL,
    "extraStudentFields" JSONB NOT NULL,
    "generalRemark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DivisionFeeStructure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DivisionFeeStructure_divisionId_key" ON "DivisionFeeStructure"("divisionId");

CREATE INDEX IF NOT EXISTS "DivisionFeeStructure_institutionId_idx" ON "DivisionFeeStructure"("institutionId");

ALTER TABLE "DivisionFeeStructure" ADD CONSTRAINT "DivisionFeeStructure_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DivisionFeeStructure" ADD CONSTRAINT "DivisionFeeStructure_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
