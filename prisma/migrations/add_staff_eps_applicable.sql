-- Payroll: "Pension (EPS) applies" per staff (off for 58+). Adds only this column.
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "epsApplicable" BOOLEAN NOT NULL DEFAULT true;
