import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("❌ Error: DATABASE_URL is missing in .env");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error("Usage: npx ts-node scripts/create-admin-simple.ts <email> <password>");
    process.exit(1);
  }

  console.log(`Creating admin with email: ${email}...`);

  try {
    const hash = await bcrypt.hash(password, 10);
    
    const admin = await prisma.admin.create({
      data: {
        email: email,
        passwordHash: hash,
        permissions: ["SUPER_ADMIN"]
      }
    });

    console.log(`✅ Admin created successfully!`);
    console.log(`ID: ${admin.id}`);
    console.log(`Email: ${admin.email}`);
  } catch (error: any) {
    if (error.code === 'P2002') {
      console.error("❌ Error: An admin with this email already exists.");
    } else {
      console.error("❌ Error creating admin:", error);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
