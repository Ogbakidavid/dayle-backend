import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const vaults = await prisma.vault.findMany({ select: { title: true, status: true, localAmount: true, localFreelancerReceives: true, localSettlementFee: true }});
  console.log(vaults);
}
main().finally(() => prisma.$disconnect());
