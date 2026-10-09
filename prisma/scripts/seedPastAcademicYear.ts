/**
 * TEST ONLY — gives ONE institution a fake CLOSED previous academic year so the
 * "previous year" dropdown / read-only views can be tried out.
 *
 * It creates (all for the year before the current one, e.g. 2025-26):
 *   - the AcademicYear row (CLOSED, not current)
 *   - a StudentEnrollment per student (same division as now)
 *   - DivisionAssignments copied from the current year (teachers show up)
 *   - ~15 school days of fake attendance, remark "[TEST-SEED]"
 *
 * The CURRENT year, students, divisions, fees, marks etc. are never touched.
 *
 * Usage (from the qubeex folder):
 *   npx tsx prisma/scripts/seedPastAcademicYear.ts <admin-email>                (preview)
 *   npx tsx prisma/scripts/seedPastAcademicYear.ts <admin-email> --yes          (create)
 *   npx tsx prisma/scripts/seedPastAcademicYear.ts <admin-email> --remove --yes (delete it again)
 */
import { prisma } from "../../src/utils/prisma";

const SEED_REMARK = "[TEST-SEED]";

function pickStatus(i: number): "P" | "A" | "L" {
  const r = (i * 7 + 3) % 10; // deterministic: ~70% P, ~20% A, ~10% L
  return r < 7 ? "P" : r < 9 ? "A" : "L";
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--yes");
  const remove = args.includes("--remove");
  const [email] = args.filter((a) => !a.startsWith("--"));
  if (!email) {
    console.log("Usage: npx tsx prisma/scripts/seedPastAcademicYear.ts <admin-email> [--remove] [--yes]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email }, select: { institutionId: true } });
  if (!user?.institutionId) {
    console.log(`No institution found for ${email}`);
    process.exit(1);
  }
  const institutionId = user.institutionId;
  const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } });

  const current = await prisma.academicYear.findFirst({ where: { institutionId, isCurrent: true } });
  if (!current) {
    console.log("This institution has no current academic year yet. Open the admin app once, then retry.");
    process.exit(1);
  }
  const startYear = current.startDate.getFullYear() - 1;
  const label = `${startYear}-${String(startYear + 1).slice(2)}`;
  const startDate = new Date(startYear, 5, 1);
  const endDate = new Date(startYear + 1, 4, 31);

  console.log(`Institution: ${institution?.name ?? institutionId}`);
  console.log(`Current year: ${current.label}   ·   test year: ${label}`);

  const past = await prisma.academicYear.findFirst({ where: { institutionId, label } });

  if (remove) {
    if (!past) {
      console.log("Test year does not exist. Nothing to remove.");
      return;
    }
    if (past.isCurrent) {
      console.log("Refusing: that year is marked current.");
      process.exit(1);
    }
    const realAtt = await prisma.attendance.count({
      where: { institutionId, academicYearId: past.id, NOT: { remark: SEED_REMARK } },
    });
    const marksheets = await prisma.marksheet.count({ where: { institutionId, academicYearId: past.id } });
    if (realAtt > 0 || marksheets > 0) {
      console.log(`Refusing: ${label} has real data (${realAtt} attendance rows, ${marksheets} marksheets) not made by this script.`);
      process.exit(1);
    }
    const counts = {
      attendance: await prisma.attendance.count({ where: { institutionId, academicYearId: past.id } }),
      enrollments: await prisma.studentEnrollment.count({ where: { institutionId, academicYearId: past.id } }),
      assignments: await prisma.divisionAssignment.count({ where: { institutionId, academicYearId: past.id } }),
    };
    console.log(`Would remove ${label}: ${counts.attendance} attendance, ${counts.enrollments} enrollments, ${counts.assignments} assignments + the year itself.`);
    if (!confirm) {
      console.log("\nPreview only. Add --yes to delete.");
      return;
    }
    await prisma.$transaction([
      prisma.attendance.deleteMany({ where: { institutionId, academicYearId: past.id } }),
      prisma.studentEnrollment.deleteMany({ where: { institutionId, academicYearId: past.id } }),
      prisma.divisionAssignment.deleteMany({ where: { institutionId, academicYearId: past.id } }),
      prisma.academicYear.delete({ where: { id: past.id } }),
    ]);
    console.log("Removed.");
    return;
  }

  const enrollments = await prisma.studentEnrollment.findMany({ where: { institutionId, academicYearId: current.id } });
  const assignments = await prisma.divisionAssignment.findMany({ where: { institutionId, academicYearId: current.id } });
  console.log(`Will copy: ${enrollments.length} enrollments, ${assignments.length} teacher assignments, plus fake attendance.`);
  if (past) console.log(`Note: ${label} already exists — only missing rows will be added.`);

  if (!confirm) {
    console.log("\nPreview only. Add --yes to create.");
    return;
  }

  const year =
    past ??
    (await prisma.academicYear.create({
      data: { institutionId, label, startDate, endDate, status: "CLOSED", isCurrent: false },
    }));

  let enrolled = 0;
  for (const e of enrollments) {
    const exists = await prisma.studentEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId: e.studentId, academicYearId: year.id } },
    });
    if (exists) continue;
    await prisma.studentEnrollment.create({
      data: {
        institutionId,
        studentId: e.studentId,
        academicYearId: year.id,
        standardId: e.standardId,
        divisionId: e.divisionId,
        rollNo: e.rollNo,
        status: e.status,
      },
    });
    enrolled++;
  }

  let assigned = 0;
  for (const a of assignments) {
    const exists = await prisma.divisionAssignment.findFirst({
      where: { divisionId: a.divisionId, subjectId: a.subjectId, institutionId, academicYearId: year.id },
    });
    if (exists) continue;
    await prisma.divisionAssignment.create({
      data: { divisionId: a.divisionId, institutionId, teacherId: a.teacherId, subjectId: a.subjectId, academicYearId: year.id },
    });
    assigned++;
  }

  // 15 weekdays starting 1 Aug of the test year.
  const days: string[] = [];
  for (let d = new Date(startYear, 7, 1); days.length < 15; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  let marked = 0;
  for (const [si, e] of enrollments.entries()) {
    for (const [di, date] of days.entries()) {
      const exists = await prisma.attendance.findFirst({ where: { divisionId: e.divisionId, studentId: e.studentId, date } });
      if (exists) continue;
      await prisma.attendance.create({
        data: {
          institutionId,
          divisionId: e.divisionId,
          studentId: e.studentId,
          date,
          status: pickStatus(si * 31 + di),
          remark: SEED_REMARK,
          academicYearId: year.id,
        },
      });
      marked++;
    }
  }

  console.log(`\nDone. Added ${enrolled} enrollments, ${assigned} assignments, ${marked} attendance rows to ${label}.`);
  console.log(`Reload the app and pick ${label} in the dropdown. Attendance data is in Aug ${startYear}.`);
  console.log("Remove later with:  npx tsx prisma/scripts/seedPastAcademicYear.ts <email> --remove --yes");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
