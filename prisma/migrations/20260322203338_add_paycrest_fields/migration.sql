/*
  Warnings:

  - A unique constraint covering the columns `[paycrestOrderId]` on the table `Vault` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Vault" ADD COLUMN     "paycrestOrderId" TEXT,
ADD COLUMN     "paycrestRate" DOUBLE PRECISION,
ADD COLUMN     "paycrestReceiveAddress" TEXT,
ADD COLUMN     "paycrestValidUntil" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Vault_paycrestOrderId_key" ON "Vault"("paycrestOrderId");

-- CreateIndex
CREATE INDEX "Vault_paycrestOrderId_idx" ON "Vault"("paycrestOrderId");
