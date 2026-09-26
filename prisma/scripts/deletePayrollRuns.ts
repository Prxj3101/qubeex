/**
 * Delete payroll runs (and their payslips) of ONE institution, for testing.
 * Works for draft AND published runs. Staff, salaries, components and
 * templates are not touched.
 *
 * The institution is picked by an admin / sub-admin login email, so runs of
 * other schools in the same database are never touched.
 *
 * Usage (from the qubeex folder):
 *   npx tsx prisma/scripts/deletePayrollRuns.ts <login-email> 2026-09 2026-10          (preview only)
 *   npx tsx prisma/scripts/deletePayrollRuns.ts <login-email> 2026-09 2026-10 --yes    (really delete)
 *
 * Note: payslip PDFs already uploaded to storage are not removed (they are
 * just no longer linked anywhere).
 */
import { prisma } from "../../src/utils/prisma";

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--yes");
  const [email, ...months] = args.filter((a) => a !== "--yes");

  if (!email || months.length === 0 || months.some((m) => !/^\d{4}-\d{2}$/.test(m))) {
    console.log("Usage: npx tsx prisma/scripts/deletePayrollRuns.ts <login-email> 2026-09 [2026-10 ...] [--yes]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email }, select: { institutionId: true, role: true } });
  if (!user?.institutionId) {
    console.log(`No institution found for ${email}`);
    process.exit(1);
  }
  const institution = await prisma.institution.findUnique({ where: { id: user.institutionId }, select: { name: true } });

  const runs = await prisma.payrollRun.findMany({
    where: { institutionId: user.institutionId, month: { in: months } },
    include: { _count: { select: { payslips: true } } },
  });

  console.log(`Institution: ${institution?.name ?? user.institutionId}`);
  if (runs.length === 0) {
    console.log(`No payroll runs found for ${months.join(", ")}`);
    return;
  }
  for (const r of runs) console.log(`  ${r.month}  ${r.status.padEnd(16)} ${r._count.payslips} payslips`);

  if (!confirm) {
    console.log("\nPreview only. Run again with --yes to delete these.");
    return;
  }

  const ids = runs.map((r) => r.id);
  const deleted = await prisma.$transaction(async (tx) => {
    const payslips = await tx.payslip.deleteMany({ where: { payrollRunId: { in: ids } } });
    const deletedRuns = await tx.payrollRun.deleteMany({ where: { id: { in: ids } } });
    return { payslips: payslips.count, runs: deletedRuns.count };
  });
  console.log(`\nDeleted ${deleted.runs} runs and ${deleted.payslips} payslips.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
