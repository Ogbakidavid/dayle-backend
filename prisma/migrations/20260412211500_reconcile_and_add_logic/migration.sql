-- Reconcile and stabilize the schema history
-- Created to merge the fragmented history of sync_current_state and add new feature columns

-- 1. VaultStatus updates (idempotent)
DO $$ BEGIN
    ALTER TYPE "VaultStatus" ADD VALUE 'RELEASING';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TYPE "VaultStatus" ADD VALUE 'RELEASE_FAILED';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TYPE "VaultStatus" ADD VALUE 'REFUNDING';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TYPE "VaultStatus" ADD VALUE 'REFUND_FAILED';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TYPE "VaultStatus" ADD VALUE 'WITHDRAWAL_FAILED';
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. EvidenceType updates (idempotent)
DO $$ BEGIN
    ALTER TYPE "EvidenceType" ADD VALUE 'DISPUTE_NOTE';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TYPE "EvidenceType" ADD VALUE 'DISPUTE_EVIDENCE';
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    ALTER TYPE "EvidenceType" ADD VALUE 'DISPUTE_DECISION';
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3. Add Columns to Vault
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Vault' AND column_name = 'requestedChanges') THEN
        ALTER TABLE "Vault" ADD COLUMN "requestedChanges" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Vault' AND column_name = 'localFreelancerReceives') THEN
        ALTER TABLE "Vault" ADD COLUMN "localFreelancerReceives" DOUBLE PRECISION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Vault' AND column_name = 'localProcessingFee') THEN
        ALTER TABLE "Vault" ADD COLUMN "localProcessingFee" DOUBLE PRECISION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Vault' AND column_name = 'localSettlementFee') THEN
        ALTER TABLE "Vault" ADD COLUMN "localSettlementFee" DOUBLE PRECISION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Vault' AND column_name = 'partnaBankCode') THEN
        ALTER TABLE "Vault" ADD COLUMN "partnaBankCode" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Vault' AND column_name = 'partnaDepositFee') THEN
        ALTER TABLE "Vault" ADD COLUMN "partnaDepositFee" DOUBLE PRECISION;
    END IF;
END $$;

-- 4. Add Columns to Dispute
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Dispute' AND column_name = 'resolutionPayload') THEN
        ALTER TABLE "Dispute" ADD COLUMN "resolutionPayload" JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Dispute' AND column_name = 'resolutionType') THEN
        ALTER TABLE "Dispute" ADD COLUMN "resolutionType" TEXT;
    END IF;
END $$;

-- 5. Add Columns to LedgerEntry
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'LedgerEntry' AND column_name = 'partnaFee') THEN
        ALTER TABLE "LedgerEntry" ADD COLUMN "partnaFee" DOUBLE PRECISION;
    END IF;
END $$;

-- 6. Add Columns and fix Indexes on User
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'kycVerifiedAt') THEN
        ALTER TABLE "User" ADD COLUMN "kycVerifiedAt" TIMESTAMP(3);
    END IF;
END $$;

-- DROP index on BVN if it exists (making it non-unique for testing/flexibility if needed by schema)
-- The drift reported 'Removed unique index on columns (bvn)'
DROP INDEX IF EXISTS "User_bvn_key";

-- 7. Add columns for partna account info that might be missing from sync_current_state
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'partnaCustomerId') THEN
        ALTER TABLE "User" ADD COLUMN "partnaCustomerId" TEXT;
    END IF;
END $$;
