-- Monthly bus fee per stop (rupees), used to fill a student's bus fee.
ALTER TABLE "TransportStop" ADD COLUMN IF NOT EXISTS "monthlyFee" INTEGER;
