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
    include: { wallet: true },
  });

  if (!user) {
    console.error('User not found!');
    process.exit(1);
  }

  if (!user.wallet) {
    console.log(`User ${user.email} does not have a wallet to reset.`);
    return;
  }

  console.log(`Found user: ${user.name} (${user.id}). Wallet Address: ${user.wallet.address}`);
  console.log('Resetting wallet (deleting Wallet record)...');

  await prisma.wallet.delete({
    where: { id: user.wallet.id },
  });

  console.log('Success! Wallet has been reset.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
