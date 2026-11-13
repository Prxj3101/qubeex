-- Removes the lesson planner (syllabus + pacing) tables created by the reset-away
-- 20261030_syllabus.sql and 20261103_pacing.sql. NOT applied automatically: run it yourself
-- on every database where those two files were applied. Safe to re-run (IF EXISTS).
BEGIN;
DROP TABLE IF EXISTS "PacingItem";
DROP TABLE IF EXISTS "PacingPlan";
DROP TABLE IF EXISTS "WeeklyPattern";
DROP TABLE IF EXISTS "SyllabusTopic";
DROP TABLE IF EXISTS "SyllabusChapter";
DROP TABLE IF EXISTS "Syllabus";
DROP TABLE IF EXISTS "SyllabusTemplateChapter";
DROP TABLE IF EXISTS "SyllabusTemplate";
COMMIT;
