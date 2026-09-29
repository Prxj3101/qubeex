-- CreateEnum
CREATE TYPE "AcademicYearStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- DropIndex
DROP INDEX "DivisionFeeStructure_divisionId_key";

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "academicYearId" TEXT;

-- AlterTable
ALTER TABLE "DivisionAssignment" ADD COLUMN     "academicYearId" TEXT;

-- AlterTable
ALTER TABLE "DivisionFeeStructure" ADD COLUMN     "academicYearId" TEXT;

-- AlterTable
ALTER TABLE "Marksheet" ADD COLUMN     "academicYearId" TEXT;

-- AlterTable
ALTER TABLE "PromotionBatch" ADD COLUMN     "academicYearId" TEXT;

-- CreateTable
CREATE TABLE "AcademicYear" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "AcademicYearStatus" NOT NULL DEFAULT 'ACTIVE',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentEnrollment" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "rollNo" TEXT,
    "status" "StudentStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DivisionTimetable" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "timetableUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DivisionTimetable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcademicYear_institutionId_isCurrent_idx" ON "AcademicYear"("institutionId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicYear_institutionId_label_key" ON "AcademicYear"("institutionId", "label");

-- CreateIndex
CREATE INDEX "StudentEnrollment_divisionId_academicYearId_idx" ON "StudentEnrollment"("divisionId", "academicYearId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_institutionId_academicYearId_idx" ON "StudentEnrollment"("institutionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentEnrollment_studentId_academicYearId_key" ON "StudentEnrollment"("studentId", "academicYearId");

-- CreateIndex
CREATE INDEX "DivisionTimetable_institutionId_academicYearId_idx" ON "DivisionTimetable"("institutionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "DivisionTimetable_divisionId_academicYearId_key" ON "DivisionTimetable"("divisionId", "academicYearId");

-- CreateIndex
CREATE INDEX "Attendance_divisionId_academicYearId_date_idx" ON "Attendance"("divisionId", "academicYearId", "date");

-- CreateIndex
CREATE INDEX "DivisionAssignment_academicYearId_idx" ON "DivisionAssignment"("academicYearId");

-- CreateIndex
CREATE INDEX "DivisionFeeStructure_academicYearId_idx" ON "DivisionFeeStructure"("academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "DivisionFeeStructure_divisionId_academicYearId_key" ON "DivisionFeeStructure"("divisionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "Marksheet_divisionId_academicYearId_key" ON "Marksheet"("divisionId", "academicYearId");

-- AddForeignKey
ALTER TABLE "DivisionAssignment" ADD CONSTRAINT "DivisionAssignment_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicYear" ADD CONSTRAINT "AcademicYear_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "Standard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionTimetable" ADD CONSTRAINT "DivisionTimetable_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionTimetable" ADD CONSTRAINT "DivisionTimetable_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionTimetable" ADD CONSTRAINT "DivisionTimetable_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionBatch" ADD CONSTRAINT "PromotionBatch_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DivisionFeeStructure" ADD CONSTRAINT "DivisionFeeStructure_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Marksheet" ADD CONSTRAINT "Marksheet_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;
