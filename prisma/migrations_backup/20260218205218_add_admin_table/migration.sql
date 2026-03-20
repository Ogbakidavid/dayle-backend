-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "permissions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_email_key" ON "Admin"("email");

-- Enable RLS on core tables
ALTER TABLE "Vault" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Milestone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dispute" ENABLE ROW LEVEL SECURITY;

-- VAULT POLICIES
-- Users can see their own vaults, Admins see all
CREATE POLICY "select_vault_policy" ON "Vault"
FOR SELECT
USING (
  "clientId" = current_setting('app.current_user_id', true)::text OR
  "freelancerId" = current_setting('app.current_user_id', true)::text OR
  current_setting('app.current_user_role', true)::text = 'admin'
);

-- Users can update their own vaults, Admins update all
CREATE POLICY "update_vault_policy" ON "Vault"
FOR UPDATE
USING (
  "clientId" = current_setting('app.current_user_id', true)::text OR
  "freelancerId" = current_setting('app.current_user_id', true)::text OR
  current_setting('app.current_user_role', true)::text = 'admin'
)
WITH CHECK (
  "clientId" = current_setting('app.current_user_id', true)::text OR
  "freelancerId" = current_setting('app.current_user_id', true)::text OR
  current_setting('app.current_user_role', true)::text = 'admin'
);

-- Users can insert vaults where they are the client (or freelancer? usually client creates)
-- Admins can insert any
CREATE POLICY "insert_vault_policy" ON "Vault"
FOR INSERT
WITH CHECK (
  "clientId" = current_setting('app.current_user_id', true)::text OR
  current_setting('app.current_user_role', true)::text = 'admin'
);

-- MILESTONE POLICIES
-- Visible if user has access to the parent Vault
CREATE POLICY "select_milestone_policy" ON "Milestone"
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM "Vault" v
    WHERE v.id = "Milestone"."vaultId"
    AND (
      v."clientId" = current_setting('app.current_user_id', true)::text OR
      v."freelancerId" = current_setting('app.current_user_id', true)::text OR
      current_setting('app.current_user_role', true)::text = 'admin'
    )
  )
);

-- DISPUTE POLICIES
-- Visible if user is the opener OR has access to the related Vault
CREATE POLICY "select_dispute_policy" ON "Dispute"
FOR SELECT
USING (
  "openedByUserId" = current_setting('app.current_user_id', true)::text OR
  EXISTS (
    SELECT 1 FROM "Vault" v
    WHERE v.id = "Dispute"."vaultId"
    AND (
      v."clientId" = current_setting('app.current_user_id', true)::text OR
      v."freelancerId" = current_setting('app.current_user_id', true)::text OR
      current_setting('app.current_user_role', true)::text = 'admin'
    )
  )
);

-- Users can update disputes they opened? Or maybe just select?
-- Usually users create disputes and maybe update status (cancel).
CREATE POLICY "update_dispute_policy" ON "Dispute"
FOR UPDATE
USING (
  "openedByUserId" = current_setting('app.current_user_id', true)::text OR
  current_setting('app.current_user_role', true)::text = 'admin'
);

CREATE POLICY "insert_dispute_policy" ON "Dispute"
FOR INSERT
WITH CHECK (
  "openedByUserId" = current_setting('app.current_user_id', true)::text OR
  current_setting('app.current_user_role', true)::text = 'admin'
);
