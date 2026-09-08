-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'healthy';
ALTER TABLE "PlaidItem" ADD COLUMN     "errorCode" TEXT;
ALTER TABLE "PlaidItem" ADD COLUMN     "lastErrorAt" TIMESTAMP(3);
