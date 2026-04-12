import sys

with open('prisma/migrations/20260411132000_sync_current_state/migration.sql', 'r') as f:
    sql = f.read()

# Replace CREATE TABLE with CREATE TABLE IF NOT EXISTS
sql = sql.replace('CREATE TABLE "', 'CREATE TABLE IF NOT EXISTS "')

# Replace CREATE UNIQUE INDEX with CREATE UNIQUE INDEX IF NOT EXISTS
sql = sql.replace('CREATE UNIQUE INDEX "', 'CREATE UNIQUE INDEX IF NOT EXISTS "')

# Replace CREATE INDEX with CREATE INDEX IF NOT EXISTS
sql = sql.replace('CREATE INDEX "', 'CREATE INDEX IF NOT EXISTS "')

# For AddForeignKey, we should use a DO block to prevent errors if the constraint already exists
# But that's harder to rig. Usually, Prisma's shadow DB reset will handle table deletion if we allow it.
# But here we are dealing with conflicting migrations.

with open('prisma/migrations/20260411132000_sync_current_state/migration.sql', 'w') as f:
    f.write(sql)
