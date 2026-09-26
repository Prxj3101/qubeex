/**
 * One-time reset of OLD payroll test data before the payroll v2 schema push
 * (money moved from rupee Floats to integer paise, templates/structures moved
 * from free-text line items to salary components).
 *
 * Deletes ALL rows in: Payslip, PayrollRun, StaffSalaryStructure, SalaryTemplate.
 * Staff rows are KEPT (their new columns are all optional / defaulted).
 *
 * Only run this because the existing payroll data is test data.
 *
 * Usage (from the qubeex folder, BEFORE `npx prisma db push`):
 *   npx tsx prisma/scripts/resetPayrollTestData.ts
 */
import { prisma } from "../../src/utils/prisma";

async function main() {
  // Raw SQL so this works with either the old or the new generated client.
  const payslips = await prisma.$executeRawUnsafe(`DELETE FROM "Payslip"`);
  const runs = await prisma.$executeRawUnsafe(`DELETE FROM "PayrollRun"`);
  const structures = await prisma.$executeRawUnsafe(`DELETE FROM "StaffSalaryStructure"`);
  const templates = await prisma.$executeRawUnsafe(`DELETE FROM "SalaryTemplate"`);
  console.log(`Deleted: ${payslips} payslips, ${runs} payroll runs, ${structures} salary structures, ${templates} templates`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
