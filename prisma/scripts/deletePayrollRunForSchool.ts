/**
 * Delete ONE payroll run (any status, including PUBLISHED) of ONE institution:
 * the run, its payslips and the payslip PDFs in storage.
 *
 * NOT touched: other months' runs, staff, salaries, settings, attendance,
 * other schools. Emails / WhatsApp already sent to staff can't be unsent.
 *
 * Usage (from the qubeex folder):
 *   npx tsx prisma/scripts/deletePayrollRunForSchool.ts <login-email> <YYYY-MM>          (preview only)
 *   npx tsx prisma/scripts/deletePayrollRunForSchool.ts <login-email> <YYYY-MM> --yes    (really delete)
 */
import { prisma } from "../../src/utils/prisma";
import { r2KeyFromUrl, deleteFromR2 } from "../../src/services/storage.service";

const rupees = (paise: number) => `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--yes");
  const [email, month] = args.filter((a) => a !== "--yes");
  if (!email || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? "")) {
    console.log("Usage: npx tsx prisma/scripts/deletePayrollRunForSchool.ts <login-email> <YYYY-MM> [--yes]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email }, select: { institutionId: true } });
  if (!user?.institutionId) {
    console.log(`No institution found for ${email}`);
    process.exit(1);
  }
  const institutionId = user.institutionId;
  const institution = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } });

  const run = await prisma.payrollRun.findFirst({ where: { institutionId, month } });
  if (!run) {
    console.log(`${institution?.name ?? institutionId}: no payroll run for ${month}. Nothing to delete.`);
    return;
  }
  const payslips = await prisma.payslip.findMany({
    where: { payrollRunId: run.id },
    select: { id: true, staffName: true, netPay: true, status: true, pdfUrl: true },
  });
  const later = await prisma.payrollRun.findMany({ where: { institutionId, month: { gt: month } }, select: { month: true, status: true }, orderBy: { month: "asc" } });

  console.log(`Institution: ${institution?.name ?? institutionId}`);
  console.log(`Run:         ${month}  (${run.status})`);
  console.log(`Payslips:    ${payslips.length}  ·  paid ${payslips.filter((p) => p.status === "PAID").length}  ·  total take-home ${rupees(payslips.reduce((s, p) => s + p.netPay, 0))}`);
  for (const p of payslips) console.log(`   - ${p.staffName.padEnd(22)} ${rupees(p.netPay).padStart(16)}  ${p.status}${p.pdfUrl ? "  (pdf)" : ""}`);
  if (later.length) {
    console.log(`\n  Note: later runs exist (${later.map((r) => `${r.month} ${r.status}`).join(", ")}).`);
    console.log("  Their TDS was worked out counting this month's tax. Re-check or recreate them after this.");
  }

  if (!confirm) {
    console.log("\nPreview only. Run again with --yes to delete this run and its payslips.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { payrollRunId: run.id } });
    await tx.payrollRun.delete({ where: { id: run.id } });
  });

  let removed = 0;
  for (const p of payslips) {
    const key = p.pdfUrl ? r2KeyFromUrl(p.pdfUrl) : null;
    if (!key) continue;
    try { await deleteFromR2(key); removed++; } catch { /* best effort: DB is already clean */ }
  }
  console.log(`\nDone. ${month} run deleted (${payslips.length} payslips, ${removed} PDFs removed from storage).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
