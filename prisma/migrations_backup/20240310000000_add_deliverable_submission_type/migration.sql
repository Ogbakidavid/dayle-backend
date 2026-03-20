-- CreateEnum
CREATE TYPE "SubmissionType" AS ENUM ('FILE', 'LINK', 'BOTH');

-- AlterTable
ALTER TABLE "Deliverable" ADD COLUMN "submissionType" "SubmissionType" NOT NULL DEFAULT 'FILE';

-- AlterEnum
ALTER TYPE "VaultType" ADD VALUE 'DEVELOPMENT';
ALTER TYPE "VaultType" ADD VALUE 'DESIGN';
ALTER TYPE "VaultType" ADD VALUE 'CONTENT_AI';