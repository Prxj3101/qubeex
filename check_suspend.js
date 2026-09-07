const { PrismaClient } = require('./src/generated/prisma/client');
const prisma = new PrismaClient();
(async () => {
  const logs = await prisma.auditLog.findMany({
    where: { action: { in: ['INSTITUTION_SUSPENDED', 'INSTITUTION_ACTIVATED', 'INSTITUTION_STATUS_CHANGED', 'TRIAL_CHURNED'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { user: { select: { name: true, email: true, role: true } }, institution: { select: { name: true } } },
  });
  for (const l of logs) {
    console.log(JSON.stringify({
      action: l.action,
      when: l.createdAt,
      institution: l.institution?.name,
      actorRole: l.actorRole,
      actorName: l.user?.name,
      actorEmail: l.user?.email,
    }));
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
