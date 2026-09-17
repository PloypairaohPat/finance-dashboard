-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Alert_userId_resolvedAt_idx" ON "Alert"("userId", "resolvedAt");
