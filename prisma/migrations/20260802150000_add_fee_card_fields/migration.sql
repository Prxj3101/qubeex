-- Add fee card customization fields (color theme, logo, school name) to DivisionFeeStructure
ALTER TABLE "DivisionFeeStructure" ADD COLUMN "feeCardTheme" TEXT;
ALTER TABLE "DivisionFeeStructure" ADD COLUMN "schoolLogoUrl" TEXT;
ALTER TABLE "DivisionFeeStructure" ADD COLUMN "schoolName" TEXT;
