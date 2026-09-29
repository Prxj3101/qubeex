-- DropForeignKey
ALTER TABLE "Attendance" DROP CONSTRAINT "Attendance_academicYearId_fkey";

-- DropForeignKey
ALTER TABLE "DivisionAssignment" DROP CONSTRAINT "DivisionAssignment_academicYearId_fkey";

-- DropForeignKey
ALTER TABLE "DivisionFeeStructure" DROP CONSTRAINT "DivisionFeeStructure_academicYearId_fkey";

-- DropForeignKey
ALTER TABLE "Marksheet" DROP CONSTRAINT "Marksheet_academicYearId_fkey";

-- DropForeignKey
ALTER TABLE "PromotionBatch" DROP CONSTRAINT "PromotionBatch_academicYearId_fkey";

-- DropIndex
DROP INDEX "Marksheet_divisionId_academicYear_key";

-- AlterTable
ALTER TABLE "Attendance" ALTER COLUMN "academicYearId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DivisionAssignment" ALTER COLUMN "academicYearId" SET NOT NULL;

-- AlterTable
ALTER TABLE "DivisionFeeStructure" ALTER COLUMN "academicYearId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Marksheet" DROP COLUMN "academicYear",
ALTER COLUMN "academicYearId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PromotionBatch" DROP COLUMN "academicYear",
ALTER COLUMN "academicYearId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DivisionAssignment_divisionId_subjectId_teacherId_academicY_key" ON "DivisionAssignment"("divisionId", "subjectId", "teacherId", "academicYearId");

-- AddForeignKey
ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionBatch" ADD CONSTRAINT "PromotionBatch_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionFeeStructure" ADD CONSTRAINT "DivisionFeeStructure_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Marksheet" ADD CONSTRAINT "Marksheet_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
