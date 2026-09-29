/**
 * Wipe ALL payroll data of ONE institution, to start testing from zero:
 * payslips, payroll runs, salary versions, templates, salary components,
 * payroll settings and the payroll Staff list.
 *
 * NOT touched: the school's teachers / admins / sub-admins themselves (their
 * QubeEx accounts), attendance, marks, fees... anything outside payroll.
 * Other schools in the same database are never touched (picked by login email).
 *
 * Usage (from the qubeex folder):
 *   npx tsx prisma/scripts/resetPayrollForSchool.ts <login-email>          (preview only)
 *   npx tsx prisma/scripts/resetPayrollForSchool.ts <login-email> --yes    (really delete)
 *
 * Payslip PDFs already uploaded to storage stay there, just unlinked.
 */
import { prisma } from "../../src/utils/prisma";

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--yes");
  const email = args.find((a) => a !== "--yes");
  if (!email) {
    console.log("Usage: npx tsx prisma/scripts/resetPayrollForSchool.ts <login-email> [--yes]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email }, select: { institutionId: true } });
  if (!user?.institutionId) {
    console.log(`No institution found for ${email}`);
    process.exit(1);
  }
  const institutionId = user.institutionId;
  const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } });

  const where = { institutionId };
  const counts = {
    payslips: await prisma.payslip.count({ where }),
    payrollRuns: await prisma.payrollRun.count({ where }),
    salaryVersions: await prisma.staffSalaryStructure.count({ where }),
    templates: await prisma.salaryTemplate.count({ where }),
    components: await prisma.salaryComponent.count({ where }),
    settings: await prisma.payrollSettings.count({ where }),
    staff: await prisma.staff.count({ where }),
  };

  console.log(`Institution: ${institution?.name ?? institutionId}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(15)} ${v}`);

  if (!confirm) {
    console.log("\nPreview only. Run again with --yes to delete all of the above.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where });
    await tx.payrollRun.deleteMany({ where });
    await tx.staffSalaryStructure.deleteMany({ where });
    await tx.salaryTemplate.deleteMany({ where });
    await tx.salaryComponent.deleteMany({ where });
    await tx.payrollSettings.deleteMany({ where });
    await tx.staff.deleteMany({ where });
  });
  console.log("\nDone. Payroll for this school is back to zero.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
