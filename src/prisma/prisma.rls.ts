
import { PrismaClient } from '@prisma/client';

/**
 * Extends the Prisma Client to inject RLS context (user ID and role) 
 * into the database session before executing queries.
 * 
 * Usage:
 * const authorizedPrisma = withRLS(prisma, user.id, user.role);
 * await authorizedPrisma.vault.findMany(...);
 */
export function withRLS(client: PrismaClient, userId: string, role: string) {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          // Wrap the operation in a transaction with set_config
          // This ensures the local config variables are set on the same connection used for the query
          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true), set_config('app.current_user_role', ${role}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}
