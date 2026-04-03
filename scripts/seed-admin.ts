import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const hashedPassword = await bcrypt.hash('kaffy100KA@', 10);
    
    await prisma.admin.upsert({
      where: { email: 'contact@orynexlabs.com' },
      update: {
        passwordHash: hashedPassword,
      },
      create: {
        email: 'contact@orynexlabs.com',
        passwordHash: hashedPassword,
        permissions: {},
      },
    });

    console.log('✅ Admin user created/updated successfully!');
  } catch (error) {
    console.error('❌ Error seeding admin:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
