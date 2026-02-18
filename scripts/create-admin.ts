import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
require('dotenv').config();

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is missing in .env");
  process.exit(1);
}
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error("Usage: npx ts-node scripts/create-admin.ts <email> <password>");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  
  try {
    const admin = await prisma.admin.create({
      data: {
        email,
        passwordHash: hash,
        permissions: ["SUPER_ADMIN"]
      }
    });
    console.log(`✅ Admin created successfully: ${admin.id} (${admin.email})`);
  } catch (e: any) {
    if (e.code === 'P2002') {
        console.error("❌ Admin with this email already exists.");
    } else {
        console.error("❌ Error creating admin:", e);
    }
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
