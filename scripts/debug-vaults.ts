import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

async function main() {
  console.log('Starting Vault Debug...');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    console.log('Executing getVaults query...');
    const vaults = await prisma.vault.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { name: true } },
        freelancer: { select: { name: true } },
      },
    });
    console.log(`Success! Found ${vaults.length} vaults.`);
    console.log(JSON.stringify(vaults, null, 2));
  } catch (error) {
    console.error('FAILED to fetch vaults:');
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
