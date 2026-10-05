-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "counterpartyEntities" TEXT[],
ADD COLUMN     "merchantEntityId" TEXT;
