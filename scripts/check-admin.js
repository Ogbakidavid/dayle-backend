const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const adminUsers = await prisma.admin.findMany();
    console.log('Admin Users:', adminUsers.map(u => ({ id: u.id, email: u.email, role: 'ADMIN' })));
  } catch (e) {
    console.error('Error fetching admins:', e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
