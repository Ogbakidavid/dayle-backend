/*
  Warnings:

  - The values [AWAITING_FUNDING,INVITED,FUNDED_UNASSIGNED,FUNDED_ASSIGNED,ACTIVE,IN_REVIEW,CLOSED,PAUSED] on the enum `VaultStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `milestoneId` on the `Dispute` table. All the data in the column will be lost.
  - You are about to drop the column `requirementRef` on the `Dispute` table. All the data in the column will be lost.
  - You are about to drop the column `milestoneId` on the `Evidence` table. All the data in the column will be lost.
  - You are about to drop the column `milestoneId` on the `LedgerEntry` table. All the data in the column will be lost.
  - You are about to alter the column `amount` on the `LedgerEntry` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `BigInt`.
  - You are about to drop the column `milestoneId` on the `Submission` table. All the data in the column will be lost.
  - You are about to drop the column `escrowRef` on the `Vault` table. All the data in the column will be lost.
  - The `type` column on the `Vault` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to alter the column `totalAmount` on the `Vault` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `BigInt`.
  - You are about to drop the `Milestone` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MilestoneReview` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Verification` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[vaultAddress]` on the table `Vault` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `vaultId` to the `Submission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `chainId` to the `Vault` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenAddress` to the `Vault` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenDecimals` to the `Vault` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "VaultType" AS ENUM ('FIXED_PRICE');

-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "VaultStatus_new" AS ENUM ('DRAFT', 'FUNDED', 'RELEASED', 'REFUNDED', 'DISPUTED', 'CANCELLED');
ALTER TABLE "public"."Vault" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Vault" ALTER COLUMN "status" TYPE "VaultStatus_new" USING ("status"::text::"VaultStatus_new");
ALTER TYPE "VaultStatus" RENAME TO "VaultStatus_old";
ALTER TYPE "VaultStatus_new" RENAME TO "VaultStatus";
DROP TYPE "public"."VaultStatus_old";
ALTER TABLE "Vault" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- DropForeignKey
ALTER TABLE "Dispute" DROP CONSTRAINT "Dispute_milestoneId_fkey";

-- DropForeignKey
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_milestoneId_fkey";

-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_milestoneId_fkey";

-- DropForeignKey
ALTER TABLE "Milestone" DROP CONSTRAINT "Milestone_vaultId_fkey";

-- DropForeignKey
ALTER TABLE "MilestoneReview" DROP CONSTRAINT "MilestoneReview_milestoneId_fkey";

-- DropForeignKey
ALTER TABLE "Submission" DROP CONSTRAINT "Submission_milestoneId_fkey";

-- DropForeignKey
ALTER TABLE "Verification" DROP CONSTRAINT "Verification_milestoneId_fkey";

-- DropIndex
DROP INDEX "Dispute_milestoneId_idx";

-- DropIndex
DROP INDEX "Evidence_milestoneId_idx";

-- DropIndex
DROP INDEX "LedgerEntry_milestoneId_idx";

-- DropIndex
DROP INDEX "Submission_milestoneId_idx";

-- DropIndex
DROP INDEX "Submission_milestoneId_key";

-- DropIndex
DROP INDEX "Vault_escrowRef_key";

-- AlterTable
ALTER TABLE "Dispute" DROP COLUMN "milestoneId",
DROP COLUMN "requirementRef",
ADD COLUMN     "deliverableId" TEXT,
ADD COLUMN     "deliverableTitle" TEXT;

-- AlterTable
ALTER TABLE "Evidence" DROP COLUMN "milestoneId";

-- AlterTable
ALTER TABLE "KycData" ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "idType" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" DROP COLUMN "milestoneId",
ALTER COLUMN "amount" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "Submission" DROP COLUMN "milestoneId",
ADD COLUMN     "deliverableStatus" JSONB,
ADD COLUMN     "vaultId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Vault" DROP COLUMN "escrowRef",
ADD COLUMN     "amount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "chainId" INTEGER NOT NULL,
ADD COLUMN     "tokenAddress" TEXT NOT NULL,
ADD COLUMN     "tokenDecimals" INTEGER NOT NULL,
ADD COLUMN     "tokenSymbol" TEXT,
ADD COLUMN     "vaultAddress" TEXT,
DROP COLUMN "type",
ADD COLUMN     "type" "VaultType" NOT NULL DEFAULT 'FIXED_PRICE',
ALTER COLUMN "totalAmount" SET DATA TYPE BIGINT;

-- DropTable
DROP TABLE "Milestone";

-- DropTable
DROP TABLE "MilestoneReview";

-- DropTable
DROP TABLE "Verification";

-- DropEnum
DROP TYPE "MilestoneReviewOutcome";

-- DropEnum
DROP TYPE "MilestoneStatus";

-- DropEnum
DROP TYPE "VerificationResult";

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "payoutMethod" TEXT NOT NULL,
    "payoutDetails" JSONB NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_SubmissionDeliverables" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_SubmissionDeliverables_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Deliverable_vaultId_idx" ON "Deliverable"("vaultId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundRequest_vaultId_key" ON "RefundRequest"("vaultId");

-- CreateIndex
CREATE INDEX "RefundRequest_clientId_idx" ON "RefundRequest"("clientId");

-- CreateIndex
CREATE INDEX "RefundRequest_status_idx" ON "RefundRequest"("status");

-- CreateIndex
CREATE INDEX "_SubmissionDeliverables_B_index" ON "_SubmissionDeliverables"("B");

-- CreateIndex
CREATE INDEX "Submission_vaultId_idx" ON "Submission"("vaultId");

-- CreateIndex
CREATE UNIQUE INDEX "Vault_vaultAddress_key" ON "Vault"("vaultAddress");

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SubmissionDeliverables" ADD CONSTRAINT "_SubmissionDeliverables_A_fkey" FOREIGN KEY ("A") REFERENCES "Deliverable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SubmissionDeliverables" ADD CONSTRAINT "_SubmissionDeliverables_B_fkey" FOREIGN KEY ("B") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
