import { prisma } from "./src/utils/prisma";

async function main() {
  const batchCount = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*) as count FROM "PromotionBatch"`).catch((e) => `error: ${e.message}`);
  const enrollmentCount = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*) as count FROM "StudentEnrollment"`).catch((e) => `error: ${e.message}`);
  const graduatedCount = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*) as count FROM "Student" WHERE status = 'GRADUATED'`).catch((e) => `error: ${e.message}`);
  console.log(JSON.stringify({ batchCount, enrollmentCount, graduatedCount }, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
