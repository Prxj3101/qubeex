-- Add per-student custom-column values to StudentFeePayment
ALTER TABLE "StudentFeePayment" ADD COLUMN "extraFields" JSONB;
