/*
  Warnings:

  - A unique constraint covering the columns `[bvn]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "User_bvn_key" ON "User"("bvn");
