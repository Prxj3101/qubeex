/**
 * READ ONLY. Shows what the database really has for Marksheet and for anything
 * "academic year" related, to compare with prisma/schema.prisma. Changes nothing.
 *
 *   npx tsx prisma/scripts/checkAcademicYearColumns.ts
 */
import { prisma } from "../../src/utils/prisma";

async function main() {
  const marksheet = await prisma.$queryRaw<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Marksheet' ORDER BY ordinal_position`;
  console.log("\n== Marksheet columns in the DB ==");
  for (const c of marksheet) console.log(`  ${c.column_name.padEnd(24)} ${c.data_type.padEnd(28)} ${c.is_nullable === "YES" ? "null" : "not null"}`);

  const related = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND (column_name ILIKE '%academicyear%' OR table_name ILIKE '%academicyear%')
    ORDER BY table_name, column_name`;
  console.log("\n== Every academic-year column / table in the DB ==");
  for (const c of related) console.log(`  ${c.table_name.padEnd(28)} ${c.column_name.padEnd(24)} ${c.data_type}`);

  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('AcademicYear', 'StudentEnrollment')`;
  if (tables.length) {
    console.log("\n== Rows ==");
    for (const t of tables) {
      const n = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM "public"."${t.table_name}"`);
      console.log(`  ${t.table_name.padEnd(28)} ${n[0].n}`);
    }
  }

  const recent = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
    SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 8`.catch(() => []);
  if (recent.length) {
    console.log("\n== Latest migrations recorded in the DB ==");
    for (const m of recent) console.log(`  ${m.migration_name.padEnd(60)} ${m.finished_at?.toISOString() ?? "not finished"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
