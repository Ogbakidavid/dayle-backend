-- 1. Drop the RLS Policies that were added
DROP POLICY IF EXISTS "select_vault_policy" ON "Vault";
DROP POLICY IF EXISTS "update_vault_policy" ON "Vault";
DROP POLICY IF EXISTS "select_milestone_policy" ON "Milestone";
-- (Add Dispute policy drops here if they were created, e.g., DROP POLICY IF EXISTS "select_dispute_policy" ON "Dispute";)

-- 2. Revoke privileges and drop the restricted user added for RLS
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    -- Revoke object-level privileges
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM app_user;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM app_user;
    
    -- Revoke default privileges
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM app_user;
    
    -- Revoke schema-level and database-level privileges
    REVOKE USAGE ON SCHEMA public FROM app_user;
    REVOKE CONNECT ON DATABASE neondb FROM app_user;
    
    -- Finally, drop the user role
    DROP USER app_user;
  END IF;
END
$$;
