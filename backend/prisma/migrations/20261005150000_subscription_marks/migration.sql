-- CreateTable
CREATE TABLE "SubscriptionMark" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionMark_userId_idx" ON "SubscriptionMark"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionMark_userId_transactionId_key" ON "SubscriptionMark"("userId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_id_userId_key" ON "Transaction"("id", "userId");

-- AddForeignKey
ALTER TABLE "SubscriptionMark" ADD CONSTRAINT "SubscriptionMark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionMark" ADD CONSTRAINT "SubscriptionMark_transactionId_userId_fkey" FOREIGN KEY ("transactionId", "userId") REFERENCES "Transaction"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

