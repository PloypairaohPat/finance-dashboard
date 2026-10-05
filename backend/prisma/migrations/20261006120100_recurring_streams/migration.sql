-- CreateEnum
CREATE TYPE "StreamDirection" AS ENUM ('inflow', 'outflow');

-- CreateTable
CREATE TABLE "RecurringStream" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "plaidAccountId" TEXT NOT NULL,
    "direction" "StreamDirection" NOT NULL,
    "description" TEXT NOT NULL,
    "merchantName" TEXT,
    "pfcPrimary" TEXT,
    "pfcDetailed" TEXT,
    "frequency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "firstDate" DATE NOT NULL,
    "lastDate" DATE NOT NULL,
    "predictedNextDate" DATE,
    "averageAmount" DECIMAL(12,2),
    "lastAmount" DECIMAL(12,2),
    "isoCurrencyCode" TEXT,
    "plaidTransactionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plaidUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringStream_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringStream_userId_idx" ON "RecurringStream"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringStream_plaidItemId_streamId_key" ON "RecurringStream"("plaidItemId", "streamId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaidItem_id_userId_key" ON "PlaidItem"("id", "userId");

-- AddForeignKey
ALTER TABLE "RecurringStream" ADD CONSTRAINT "RecurringStream_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringStream" ADD CONSTRAINT "RecurringStream_plaidItemId_userId_fkey" FOREIGN KEY ("plaidItemId", "userId") REFERENCES "PlaidItem"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
