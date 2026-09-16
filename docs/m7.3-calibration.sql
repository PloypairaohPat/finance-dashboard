-- ─────────────────────────────────────────────────────────────────
--  M7.3 calibration query — COUNTS ONLY, READ-ONLY
--
--  Purpose: learn the SHAPE of real Plaid data (which category codes occur on
--  which account types and in which direction, whether pending rows link to
--  their posted rows, what counterparty data exists, and how many transfer-
--  shaped pairs the current transfer filter would miss) so the extended demo
--  seed mirrors reality instead of assumptions.
--
--  What it returns: counts, Plaid's own enum values (category codes,
--  counterparty types, confidence levels), account types and yes/no flags.
--  What it never returns: amounts, dates, merchant or institution names,
--  transaction/account/user IDs. Users appear as user_n (1, 2, ...), a rank.
--  The demo user is excluded. Soft-deleted rows are excluded except in the
--  pending-lifecycle section, which counts them.
--
--  Run it once in Supabase's SQL editor. It only SELECTs.
-- ─────────────────────────────────────────────────────────────────

WITH
users AS (
  SELECT u.id, dense_rank() OVER (ORDER BY u."createdAt", u.id) AS user_n
  FROM "User" u
  WHERE u.id <> 'demo-user'
    AND EXISTS (SELECT 1 FROM "Transaction" t WHERE t."userId" = u.id)
),
tx AS (
  SELECT t.id, t."userId", us.user_n, t."accountId",
         a.type                                   AS account_type,
         t.date::date                             AS d,
         t.amount,
         t.pending,
         COALESCE(t."categoryPrimary",  '(none)') AS primary_cat,
         COALESCE(t."categoryDetailed", '(none)') AS detailed_cat,
         t."rawJson"                              AS raw,
         CASE WHEN jsonb_typeof(t."rawJson"->'counterparties') = 'array'
              THEN t."rawJson"->'counterparties' ELSE '[]'::jsonb END AS counterparties,
         t."merchantName" IS NOT NULL             AS has_merchant
  FROM "Transaction" t
  JOIN users us    ON us.id = t."userId"
  JOIN "Account" a ON a.id  = t."accountId"
  WHERE t."deletedAt" IS NULL
),
-- Linked institution names, normalized the way src/utils/transferFilter.ts does.
-- Compared inside the query only; never selected into the output.
inst AS (
  SELECT p."userId", regexp_replace(lower(p."institutionName"), '[^a-z0-9]', '', 'g') AS norm
  FROM "PlaidItem" p
  WHERE p."institutionName" IS NOT NULL
),
-- Rows the current Tier 1 filter flags: a TRANSFER_* row whose counterparties
-- include a financial_institution matching one of the user's linked institutions.
tier1 AS (
  SELECT tx.id
  FROM tx
  WHERE tx.primary_cat ~* '^TRANSFER_(IN|OUT)'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(tx.counterparties) cp
      JOIN inst ON inst."userId" = tx."userId"
      WHERE cp->>'type' = 'financial_institution'
        AND regexp_replace(lower(COALESCE(cp->>'name', '')), '[^a-z0-9]', '', 'g') = inst.norm
    )
),
-- Every outflow paired with its NEAREST opposite-amount inflow on a DIFFERENT
-- linked account of the same user, within 7 days. One pair per outflow.
pairs AS (
  SELECT o.user_n,
         o.id AS out_id, o.primary_cat AS out_cat, o.account_type AS out_acct,
         m.id AS in_id,  m.primary_cat AS in_cat,  m.account_type AS in_acct,
         m.gap
  FROM tx o
  CROSS JOIN LATERAL (
    SELECT i.id, i.primary_cat, i.account_type, abs(i.d - o.d) AS gap
    FROM tx i
    WHERE i."userId" = o."userId"
      AND i."accountId" <> o."accountId"
      AND i.amount < 0
      AND abs(i.amount + o.amount) < 0.01
      AND abs(i.d - o.d) <= 7
    ORDER BY abs(i.d - o.d), i.id
    LIMIT 1
  ) m
  WHERE o.amount > 0
),
paired_in AS (SELECT DISTINCT in_id FROM pairs),

results AS (
  -- 0. Overview per user: linked accounts by type, and transaction counts.
  SELECT '0 overview' AS section, us.user_n,
         'accounts: ' || a.type AS a, NULL::text AS b, NULL::text AS c, NULL::text AS d,
         count(*) AS n
  FROM "Account" a JOIN users us ON us.id = a."userId"
  GROUP BY us.user_n, a.type
  UNION ALL
  SELECT '0 overview', user_n, 'transactions (not deleted)', NULL, NULL, NULL, count(*)
  FROM tx GROUP BY user_n
  UNION ALL
  SELECT '0 overview', user_n, 'distinct calendar months with transactions', NULL, NULL, NULL,
         count(DISTINCT date_trunc('month', d))
  FROM tx GROUP BY user_n

  UNION ALL
  -- 1. Shape: which Plaid categories occur, on which account type, which direction, pending or posted.
  SELECT '1 shape: account | direction | pending | primary > detailed', user_n,
         account_type,
         CASE WHEN amount > 0 THEN 'out' WHEN amount < 0 THEN 'in' ELSE 'zero' END,
         CASE WHEN pending THEN 'pending' ELSE 'posted' END,
         primary_cat || ' > ' || detailed_cat,
         count(*)
  FROM tx GROUP BY 2, 3, 4, 5, 6

  UNION ALL
  -- 2. Which fields Plaid actually populates.
  SELECT '2 fields present: direction | pending | field | present?', tx.user_n,
         CASE WHEN tx.amount > 0 THEN 'out' ELSE 'in' END,
         CASE WHEN tx.pending THEN 'pending' ELSE 'posted' END,
         f.field,
         CASE WHEN f.present THEN 'yes' ELSE 'no' END,
         count(*)
  FROM tx
  CROSS JOIN LATERAL (VALUES
    ('rawJson stored',             tx.raw IS NOT NULL),
    ('pending_transaction_id set', tx.raw->>'pending_transaction_id' IS NOT NULL),
    ('counterparties non-empty',   jsonb_array_length(tx.counterparties) > 0),
    ('merchant_name set',          tx.has_merchant)
  ) AS f(field, present)
  GROUP BY 2, 3, 4, 5, 6
  UNION ALL
  SELECT '2 fields present: direction | pending | field | present?', user_n,
         CASE WHEN amount > 0 THEN 'out' ELSE 'in' END,
         CASE WHEN pending THEN 'pending' ELSE 'posted' END,
         'category confidence_level',
         COALESCE(raw->'personal_finance_category'->>'confidence_level', '(missing)'),
         count(*)
  FROM tx GROUP BY 2, 3, 4, 6

  UNION ALL
  -- 3. Counterparty types on transfer and loan-payment rows, and whether a
  --    financial_institution counterparty matches a linked institution.
  SELECT '3 counterparties: primary | counterparty type | matches linked institution?', tx.user_n,
         tx.primary_cat,
         COALESCE(cp->>'type', '(none)'),
         CASE WHEN EXISTS (
                SELECT 1 FROM inst
                WHERE inst."userId" = tx."userId"
                  AND regexp_replace(lower(COALESCE(cp->>'name', '')), '[^a-z0-9]', '', 'g') = inst.norm)
              THEN 'yes' ELSE 'no' END,
         NULL,
         count(*)
  FROM tx
  CROSS JOIN LATERAL jsonb_array_elements(tx.counterparties) cp
  WHERE tx.primary_cat ~* '^(TRANSFER_|LOAN_PAYMENTS)'
  GROUP BY 2, 3, 4, 5

  UNION ALL
  -- 4. Pending lifecycle (includes soft-deleted rows).
  SELECT '4 pending: state', us.user_n,
         CASE WHEN t.pending AND t."deletedAt" IS NULL     THEN 'pending, active'
              WHEN t.pending AND t."deletedAt" IS NOT NULL THEN 'pending, soft-deleted'
              ELSE 'posted, active' END,
         CASE WHEN t.pending AND t."deletedAt" IS NULL THEN
                CASE WHEN t.date >= now() - interval '3 days'  THEN 'age 0-3 days'
                     WHEN t.date >= now() - interval '10 days' THEN 'age 4-10 days'
                     ELSE 'age over 10 days' END
              END,
         NULL, NULL, count(*)
  FROM "Transaction" t JOIN users us ON us.id = t."userId"
  WHERE t.pending OR t."deletedAt" IS NULL
  GROUP BY 2, 3, 4
  UNION ALL
  -- Posted rows that name their pending row, and whether that pending row is STILL
  -- active (both counted = double count).
  SELECT '4 pending: posted rows linking a pending_transaction_id', us.user_n,
         CASE WHEN p.id IS NULL                THEN 'linked pending row not in table'
              WHEN p."deletedAt" IS NOT NULL   THEN 'linked pending row soft-deleted (ok)'
              ELSE 'linked pending row STILL ACTIVE (double count)' END,
         NULL, NULL, NULL, count(*)
  FROM "Transaction" t
  JOIN users us ON us.id = t."userId"
  LEFT JOIN "Transaction" p ON p."plaidTransactionId" = t."rawJson"->>'pending_transaction_id'
  WHERE t."deletedAt" IS NULL AND NOT t.pending
    AND t."rawJson"->>'pending_transaction_id' IS NOT NULL
  GROUP BY 2, 3

  UNION ALL
  -- 5. Transfer-shaped pairs and whether the CURRENT filter would catch them.
  --    Current filter = Tier 1 (counterparty matches a linked institution) OR
  --    Tier 2 (both legs TRANSFER_* AND same day). A miss counts the money as
  --    both spend and income.
  SELECT '5 pairs: day gap | accounts out->in | categories out->in | filter catches?', user_n,
         CASE WHEN gap = 0 THEN '0 days' WHEN gap = 1 THEN '1 day'
              WHEN gap <= 3 THEN '2-3 days' ELSE '4-7 days' END,
         out_acct || ' -> ' || in_acct,
         out_cat || ' -> ' || in_cat,
         CASE WHEN out_id IN (SELECT id FROM tier1) OR in_id IN (SELECT id FROM tier1)
                   OR (out_cat ~* '^TRANSFER_(IN|OUT)' AND in_cat ~* '^TRANSFER_(IN|OUT)' AND gap = 0)
              THEN 'caught' ELSE 'MISSED' END,
         count(*)
  FROM pairs
  GROUP BY 2, 3, 4, 5, 6

  UNION ALL
  -- 6. Transfers out: which detailed codes occur, and whether a matching inflow
  --    on another linked account exists (internal) or not (external). Informs the
  --    deferred decision on non-savings transfers out.
  SELECT '6 transfers out: account | detailed | matched to a linked inflow?', tx.user_n,
         tx.account_type,
         tx.detailed_cat,
         CASE WHEN EXISTS (SELECT 1 FROM pairs p WHERE p.out_id = tx.id) THEN 'internal (matched)' ELSE 'external (no match)' END,
         NULL,
         count(*)
  FROM tx
  WHERE tx.amount > 0 AND tx.primary_cat ~* '^TRANSFER_OUT'
  GROUP BY 2, 3, 4, 5

  UNION ALL
  -- 7. Inflows: what they are. Spending-category inflows are refunds; LOAN_PAYMENTS
  --    inflows on credit accounts are card-payment credits; matched inflows are
  --    internal transfers.
  SELECT '7 inflows: account | primary > detailed | matched to a linked outflow?', tx.user_n,
         tx.account_type,
         tx.primary_cat || ' > ' || tx.detailed_cat,
         CASE WHEN tx.id IN (SELECT in_id FROM paired_in) THEN 'internal (matched)' ELSE 'not matched' END,
         NULL,
         count(*)
  FROM tx
  WHERE tx.amount < 0
  GROUP BY 2, 3, 4, 5

  UNION ALL
  -- 8. For the savings-rate floor: in each of the last 12 completed calendar months,
  --    how many INCOME-category inflows arrived. Returns a count of MONTHS per bucket.
  SELECT '8 income cadence: INCOME inflows per completed month -> number of months', user_n,
         CASE WHEN k = 0 THEN '0' WHEN k = 1 THEN '1' WHEN k <= 3 THEN '2-3' ELSE '4+' END,
         NULL, NULL, NULL, count(*)
  FROM (
    SELECT us.user_n, m.month,
           (SELECT count(*) FROM tx
             WHERE tx.user_n = us.user_n AND tx.amount < 0 AND tx.primary_cat = 'INCOME'
               AND date_trunc('month', tx.d) = m.month) AS k
    FROM users us
    CROSS JOIN LATERAL (
      SELECT generate_series(date_trunc('month', now()) - interval '12 months',
                             date_trunc('month', now()) - interval '1 month',
                             interval '1 month') AS month
    ) m
    WHERE m.month >= (SELECT date_trunc('month', min(tx.d)) FROM tx WHERE tx.user_n = us.user_n)
  ) per_month
  GROUP BY 2, 3
)
SELECT section, user_n, a, b, c, d, n
FROM results
ORDER BY section, user_n, n DESC, a, b, c, d;
