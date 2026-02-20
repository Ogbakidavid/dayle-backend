const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    const policies = await prisma.$queryRawUnsafe(`
      SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
      FROM pg_policies;
    `);
    console.log('RLS Policies:', JSON.stringify(policies, null, 2));

    const enabledRLS = await prisma.$queryRawUnsafe(`
      SELECT relname, relrowsecurity 
      FROM pg_class c 
      JOIN pg_namespace n ON n.oid = c.relnamespace 
      WHERE n.nspname = 'public' AND relkind = 'r' AND relrowsecurity = true;
    `);
    console.log('Tables with RLS enabled:', JSON.stringify(enabledRLS, null, 2));
  } catch (e) {
    console.error('Error fetching RLS info:', e);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
