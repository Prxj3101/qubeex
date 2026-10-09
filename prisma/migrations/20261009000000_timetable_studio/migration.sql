-- CreateEnum
CREATE TYPE "TimetableStatus" AS ENUM ('DRAFT', 'GENERATED', 'UNDER_REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TimeSlotKind" AS ENUM ('PERIOD', 'BREAK', 'LUNCH', 'ASSEMBLY', 'ACTIVITY');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('THEORY', 'PRACTICAL', 'LAB', 'ACTIVITY', 'PE_SPORTS', 'LIBRARY', 'CLASS_TEACHER', 'ASSEMBLY', 'BREAK', 'LUNCH', 'FREE', 'EXAM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AvailabilityKind" AS ENUM ('UNAVAILABLE', 'PREFERRED');

-- CreateEnum
CREATE TYPE "TimetableExceptionKind" AS ENUM ('OVERRIDE', 'CANCEL');

-- CreateTable
CREATE TABLE "TimetableSettings" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "workingDays" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeSlot" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "kind" "TimeSlotKind" NOT NULL DEFAULT 'PERIOD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableSessionType" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SessionKind" NOT NULL,
    "requiresTeacher" BOOLEAN NOT NULL DEFAULT true,
    "requiresRoom" BOOLEAN NOT NULL DEFAULT false,
    "roomType" TEXT,
    "defaultSpan" INTEGER NOT NULL DEFAULT 1,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableSessionType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CLASSROOM',
    "capacity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomUnavailability" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "slotId" TEXT NOT NULL,

    CONSTRAINT "RoomUnavailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherAvailability" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "slotId" TEXT NOT NULL,
    "kind" "AvailabilityKind" NOT NULL DEFAULT 'UNAVAILABLE',

    CONSTRAINT "TeacherAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherTimetablePref" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "maxPeriodsPerDay" INTEGER,
    "maxConsecutive" INTEGER,
    "maxPeriodsPerWeek" INTEGER,

    CONSTRAINT "TeacherTimetablePref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolTimetable" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "status" "TimetableStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolTimetable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableSubjectConfig" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "subjectId" TEXT,
    "sessionTypeId" TEXT NOT NULL,
    "title" TEXT,
    "periodsPerWeek" INTEGER NOT NULL DEFAULT 1,
    "span" INTEGER NOT NULL DEFAULT 1,
    "maxPerDay" INTEGER NOT NULL DEFAULT 1,
    "teacherId" TEXT,
    "roomId" TEXT,
    "roomType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableSubjectConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableEntry" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "timetableId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "slotId" TEXT NOT NULL,
    "sessionTypeId" TEXT NOT NULL,
    "subjectId" TEXT,
    "title" TEXT,
    "teacherId" TEXT,
    "roomId" TEXT,
    "configId" TEXT,
    "groupId" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableException" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "slotId" TEXT NOT NULL,
    "kind" "TimetableExceptionKind" NOT NULL DEFAULT 'OVERRIDE',
    "sessionTypeId" TEXT,
    "subjectId" TEXT,
    "title" TEXT,
    "teacherId" TEXT,
    "roomId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimetableException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableSubstitution" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "originalTeacherId" TEXT,
    "substituteTeacherId" TEXT NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimetableSubstitution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableGeneration" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "timetableId" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "placed" INTEGER NOT NULL,
    "unplaced" INTEGER NOT NULL,
    "problems" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimetableGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimetableSettings_institutionId_academicYearId_key" ON "TimetableSettings"("institutionId", "academicYearId");

-- CreateIndex
CREATE INDEX "TimeSlot_institutionId_academicYearId_idx" ON "TimeSlot"("institutionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "TimeSlot_institutionId_academicYearId_order_key" ON "TimeSlot"("institutionId", "academicYearId", "order");

-- CreateIndex
CREATE INDEX "TimetableSessionType_institutionId_idx" ON "TimetableSessionType"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableSessionType_institutionId_name_key" ON "TimetableSessionType"("institutionId", "name");

-- CreateIndex
CREATE INDEX "Room_institutionId_idx" ON "Room"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_institutionId_name_key" ON "Room"("institutionId", "name");

-- CreateIndex
CREATE INDEX "RoomUnavailability_institutionId_academicYearId_idx" ON "RoomUnavailability"("institutionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomUnavailability_roomId_academicYearId_dayOfWeek_slotId_key" ON "RoomUnavailability"("roomId", "academicYearId", "dayOfWeek", "slotId");

-- CreateIndex
CREATE INDEX "TeacherAvailability_institutionId_academicYearId_idx" ON "TeacherAvailability"("institutionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherAvailability_teacherId_academicYearId_dayOfWeek_slot_key" ON "TeacherAvailability"("teacherId", "academicYearId", "dayOfWeek", "slotId");

-- CreateIndex
CREATE INDEX "TeacherTimetablePref_institutionId_academicYearId_idx" ON "TeacherTimetablePref"("institutionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherTimetablePref_teacherId_academicYearId_key" ON "TeacherTimetablePref"("teacherId", "academicYearId");

-- CreateIndex
CREATE INDEX "SchoolTimetable_institutionId_academicYearId_idx" ON "SchoolTimetable"("institutionId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolTimetable_divisionId_academicYearId_key" ON "SchoolTimetable"("divisionId", "academicYearId");

-- CreateIndex
CREATE INDEX "TimetableSubjectConfig_institutionId_academicYearId_divisio_idx" ON "TimetableSubjectConfig"("institutionId", "academicYearId", "divisionId");

-- CreateIndex
CREATE INDEX "TimetableEntry_institutionId_academicYearId_idx" ON "TimetableEntry"("institutionId", "academicYearId");

-- CreateIndex
CREATE INDEX "TimetableEntry_academicYearId_divisionId_idx" ON "TimetableEntry"("academicYearId", "divisionId");

-- CreateIndex
CREATE INDEX "TimetableEntry_academicYearId_teacherId_dayOfWeek_idx" ON "TimetableEntry"("academicYearId", "teacherId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "TimetableEntry_academicYearId_roomId_dayOfWeek_idx" ON "TimetableEntry"("academicYearId", "roomId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableEntry_timetableId_dayOfWeek_slotId_key" ON "TimetableEntry"("timetableId", "dayOfWeek", "slotId");

-- CreateIndex
CREATE INDEX "TimetableException_institutionId_academicYearId_date_idx" ON "TimetableException"("institutionId", "academicYearId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableException_divisionId_date_slotId_key" ON "TimetableException"("divisionId", "date", "slotId");

-- CreateIndex
CREATE INDEX "TimetableSubstitution_institutionId_academicYearId_date_idx" ON "TimetableSubstitution"("institutionId", "academicYearId", "date");

-- CreateIndex
CREATE INDEX "TimetableSubstitution_substituteTeacherId_date_idx" ON "TimetableSubstitution"("substituteTeacherId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableSubstitution_entryId_date_key" ON "TimetableSubstitution"("entryId", "date");

-- CreateIndex
CREATE INDEX "TimetableGeneration_timetableId_createdAt_idx" ON "TimetableGeneration"("timetableId", "createdAt");

-- AddForeignKey
ALTER TABLE "TimetableSettings" ADD CONSTRAINT "TimetableSettings_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSettings" ADD CONSTRAINT "TimetableSettings_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeSlot" ADD CONSTRAINT "TimeSlot_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeSlot" ADD CONSTRAINT "TimeSlot_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSessionType" ADD CONSTRAINT "TimetableSessionType_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomUnavailability" ADD CONSTRAINT "RoomUnavailability_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomUnavailability" ADD CONSTRAINT "RoomUnavailability_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomUnavailability" ADD CONSTRAINT "RoomUnavailability_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomUnavailability" ADD CONSTRAINT "RoomUnavailability_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TimeSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAvailability" ADD CONSTRAINT "TeacherAvailability_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAvailability" ADD CONSTRAINT "TeacherAvailability_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAvailability" ADD CONSTRAINT "TeacherAvailability_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAvailability" ADD CONSTRAINT "TeacherAvailability_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TimeSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherTimetablePref" ADD CONSTRAINT "TeacherTimetablePref_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherTimetablePref" ADD CONSTRAINT "TeacherTimetablePref_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherTimetablePref" ADD CONSTRAINT "TeacherTimetablePref_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolTimetable" ADD CONSTRAINT "SchoolTimetable_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolTimetable" ADD CONSTRAINT "SchoolTimetable_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolTimetable" ADD CONSTRAINT "SchoolTimetable_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubjectConfig" ADD CONSTRAINT "TimetableSubjectConfig_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubjectConfig" ADD CONSTRAINT "TimetableSubjectConfig_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubjectConfig" ADD CONSTRAINT "TimetableSubjectConfig_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubjectConfig" ADD CONSTRAINT "TimetableSubjectConfig_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubjectConfig" ADD CONSTRAINT "TimetableSubjectConfig_sessionTypeId_fkey" FOREIGN KEY ("sessionTypeId") REFERENCES "TimetableSessionType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubjectConfig" ADD CONSTRAINT "TimetableSubjectConfig_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubjectConfig" ADD CONSTRAINT "TimetableSubjectConfig_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_timetableId_fkey" FOREIGN KEY ("timetableId") REFERENCES "SchoolTimetable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TimeSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_sessionTypeId_fkey" FOREIGN KEY ("sessionTypeId") REFERENCES "TimetableSessionType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_configId_fkey" FOREIGN KEY ("configId") REFERENCES "TimetableSubjectConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TimeSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_sessionTypeId_fkey" FOREIGN KEY ("sessionTypeId") REFERENCES "TimetableSessionType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableException" ADD CONSTRAINT "TimetableException_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubstitution" ADD CONSTRAINT "TimetableSubstitution_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubstitution" ADD CONSTRAINT "TimetableSubstitution_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubstitution" ADD CONSTRAINT "TimetableSubstitution_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "TimetableEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSubstitution" ADD CONSTRAINT "TimetableSubstitution_substituteTeacherId_fkey" FOREIGN KEY ("substituteTeacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableGeneration" ADD CONSTRAINT "TimetableGeneration_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableGeneration" ADD CONSTRAINT "TimetableGeneration_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableGeneration" ADD CONSTRAINT "TimetableGeneration_timetableId_fkey" FOREIGN KEY ("timetableId") REFERENCES "SchoolTimetable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

