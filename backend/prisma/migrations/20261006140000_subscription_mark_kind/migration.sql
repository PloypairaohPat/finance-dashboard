-- M7.6 PR 4: a mark is a confirmation or a dismissal. Columns only.
-- Existing marks become confirmations through the default; on Postgres 11+
-- adding a column with a constant default doesn't rewrite the table.

-- CreateEnum
CREATE TYPE "MarkKind" AS ENUM ('confirmed', 'dismissed');

-- AlterTable
ALTER TABLE "SubscriptionMark" ADD COLUMN     "kind" "MarkKind" NOT NULL DEFAULT 'confirmed';
