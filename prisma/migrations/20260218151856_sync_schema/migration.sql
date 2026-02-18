/*
  Warnings:

  - The values [CLARIFICATION_REQUEST,REQUIREMENT_CONFIRMATION,FILE_COMMENT,DISPUTE_NOTE,DISPUTE_OPENED,DISPUTE_EVIDENCE,DISPUTE_DECISION] on the enum `EvidenceType` will be removed. If these variants are still used in the database, this will fail.
  - The values [COMPLETED] on the enum `VaultStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "EvidenceType_new" AS ENUM ('MESSAGE', 'MESSAGE_SENT', 'REQUIREMENT_ITEM', 'SUBMISSION_DELTA', 'REVIEW_DECISION', 'DISPUTE_EVENT');
ALTER TABLE "Evidence" ALTER COLUMN "type" TYPE "EvidenceType_new" USING ("type"::text::"EvidenceType_new");
ALTER TYPE "EvidenceType" RENAME TO "EvidenceType_old";
ALTER TYPE "EvidenceType_new" RENAME TO "EvidenceType";
DROP TYPE "public"."EvidenceType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "VaultStatus_new" AS ENUM ('DRAFT', 'AWAITING_FUNDING', 'INVITED', 'FUNDED_UNASSIGNED', 'FUNDED_ASSIGNED', 'ACTIVE', 'IN_REVIEW', 'CLOSED', 'CANCELLED', 'PAUSED', 'DISPUTED');
ALTER TABLE "public"."Vault" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Vault" ALTER COLUMN "status" TYPE "VaultStatus_new" USING ("status"::text::"VaultStatus_new");
ALTER TYPE "VaultStatus" RENAME TO "VaultStatus_old";
ALTER TYPE "VaultStatus_new" RENAME TO "VaultStatus";
DROP TYPE "public"."VaultStatus_old";
ALTER TABLE "Vault" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "twoFaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorSecret" TEXT;

-- AlterTable
ALTER TABLE "Vault" ADD COLUMN     "frozenReason" TEXT,
ADD COLUMN     "isFrozen" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "privyDid" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PRIVY',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "telegramConnected" BOOLEAN NOT NULL DEFAULT false,
    "telegramUsername" TEXT,
    "telegramChatId" TEXT,
    "whatsappPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "whatsappPhoneE164" TEXT,
    "whatsappConfirmCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_address_key" ON "Wallet"("address");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_privyDid_key" ON "Wallet"("privyDid");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Notification_read_idx" ON "Notification"("read");

-- CreateIndex
CREATE INDEX "Notification_timestamp_idx" ON "Notification"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreferences_userId_key" ON "NotificationPreferences"("userId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreferences" ADD CONSTRAINT "NotificationPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
