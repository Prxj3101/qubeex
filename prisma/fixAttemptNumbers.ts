// One-off maintenance script: renumbers TaskAssignmentSubmissionAttempt rows
// per submission, oldest → newest, to clean up any duplicate/inconsistent
// attemptNumber values left over from testing the attempt-history feature
// before the numbering bug was fixed. Safe to run multiple times.
//
// Run once with:  npx tsx prisma/fixAttemptNumbers.ts
import { prisma } from "../src/utils/prisma";

async function main() {
  const submissionIds = await prisma.taskAssignmentSubmissionAttempt.findMany({
    select: { submissionId: true },
    distinct: ["submissionId"],
  });

  let fixed = 0;
  for (const { submissionId } of submissionIds) {
    const attempts = await prisma.taskAssignmentSubmissionAttempt.findMany({
      where: { submissionId },
      orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }],
    });
    for (let i = 0; i < attempts.length; i++) {
      const correctNumber = i + 1;
      if (attempts[i].attemptNumber !== correctNumber) {
        await prisma.taskAssignmentSubmissionAttempt.update({
          where: { id: attempts[i].id },
          data: { attemptNumber: correctNumber },
        });
        fixed++;
      }
    }
  }
  console.log(`Done. Renumbered ${fixed} attempt row(s) across ${submissionIds.length} submission(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
