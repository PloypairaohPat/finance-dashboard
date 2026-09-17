-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "verdictOverride" TEXT,
ADD COLUMN     "verdictOverrideAt" TIMESTAMP(3);
