import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('--- Testing Vault.findMany ---');
    try {
      const vaults = await prisma.vault.findMany({ take: 1 });
      console.log('Vault.findMany success:', vaults.length);
    } catch (e) {
      console.error('Vault.findMany failed:', e.message);
      if (e.meta) console.log('Meta:', e.meta);
    }

    console.log('\n--- Checking Vault columns via queryRaw ---');
    const columns = await prisma.$queryRaw`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'Vault'
      ORDER BY column_name;
    `;
    console.log(JSON.stringify(columns, null, 2));

    console.log('\n--- Checking Deliverable columns via queryRaw ---');
    const dColumns = await prisma.$queryRaw`
      SELECT column_description(pg_attribute.attrelid, pg_attribute.attnum) as comment,
             attname as column_name
      FROM pg_attribute
      JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
      WHERE pg_class.relname = 'Vault' AND attnum > 0 AND NOT attisdropped;
    `;
    // console.log(JSON.stringify(dColumns, null, 2));

  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
