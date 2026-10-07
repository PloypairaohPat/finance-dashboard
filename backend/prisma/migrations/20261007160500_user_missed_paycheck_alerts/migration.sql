-- M7.6 PR 6a: the missed-paycheck opt-in. Column only; nothing reads it until 6b.
-- Off for everyone, existing users included: the alert is opt-in. On Postgres 11+
-- adding a column with a constant default doesn't rewrite the table.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "missedPaycheckAlerts" BOOLEAN NOT NULL DEFAULT false;
