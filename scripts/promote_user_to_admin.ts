import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];

  if (!email) {
    console.error('Please provide an email address as an argument.');
    process.exit(1);
  }

  console.log(`Looking for user with email: ${email}...`);

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    console.error('User not found!');
    process.exit(1);
  }

  console.log(`Found user: ${user.name} (${user.id}). Current Role: ${user.role}`);
  console.log('Promoting to ADMIN...');

  await prisma.user.update({
    where: { id: user.id },
    data: { role: 'ADMIN' },
  });

  console.log('Success! User is now an ADMIN.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
