-- Dedupe: for each (userId, category) keep the most recently updated row
DELETE FROM "Budget" b1
USING "Budget" b2
WHERE b1."userId" = b2."userId"
  AND b1.category = b2.category
  AND (
    b1."updatedAt" < b2."updatedAt"
    OR (b1."updatedAt" = b2."updatedAt" AND b1.id < b2.id)
  );

ALTER TABLE "Budget" DROP CONSTRAINT IF EXISTS "Budget_userId_category_month_key";
DROP INDEX IF EXISTS "Budget_userId_month_idx";
ALTER TABLE "Budget" DROP COLUMN IF EXISTS "month";
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_category_key" UNIQUE ("userId", "category");
CREATE INDEX IF NOT EXISTS "Budget_userId_idx" ON "Budget"("userId");
