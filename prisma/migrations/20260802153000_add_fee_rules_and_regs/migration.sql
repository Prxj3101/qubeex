-- Add Rules & Regulations (back of fee card) storage to DivisionFeeStructure
ALTER TABLE "DivisionFeeStructure" ADD COLUMN "rulesAndRegs" JSONB;
