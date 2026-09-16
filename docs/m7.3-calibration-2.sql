-- ─────────────────────────────────────────────────────────────────
--  M7.3 calibration query 2 — COUNTS ONLY, READ-ONLY
--
--  Follow-up to docs/m7.3-calibration.sql. Four breakdowns:
--    A. Transfers out: detailed code x counterparty type x internally matched?
--       (confirms whether the 48 external ACCOUNT_TRANSFER outflows are
--       payment-app flows)
--    B. OTHER_OTHER: direction x account x counterparty type x confidence x
--       merchant_name set x matched? (to classify the 55 unclassified inflows)
--    C. Confidence x primary category x direction x account (where LOW
--       confidence concentrates)
--    D. Unpaired card-payment outflows: nearest credit-account inflow within 31
--       days, as an amount-DIFFERENCE bucket and a day-gap bucket (to set the
--       classifier's step-1 amount tolerance from data)
--
--  Returns counts, Plaid enum values, account types, yes/no flags and buckets.
--  Never returns amounts, dates, merchant or institution names, or any IDs.
--  Users appear as user_n (1, 2, ...). The demo user is excluded.
--
--  A row with several counterparties is counted once per counterparty in A and B.
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
         COALESCE(t."rawJson"->'personal_finance_category'->>'confidence_level', '(missing)') AS confidence,
         CASE WHEN jsonb_typeof(t."rawJson"->'counterparties') = 'array'
              THEN t."rawJson"->'counterparties' ELSE '[]'::jsonb END AS counterparties,
         t."merchantName" IS NOT NULL             AS has_merchant
  FROM "Transaction" t
  JOIN users us    ON us.id = t."userId"
  JOIN "Account" a ON a.id  = t."accountId"
  WHERE t."deletedAt" IS NULL
),
inst AS (
  SELECT p."userId", regexp_replace(lower(p."institutionName"), '[^a-z0-9]', '', 'g') AS norm
  FROM "PlaidItem" p
  WHERE p."institutionName" IS NOT NULL
),
-- Same pairing as calibration query 1: each outflow with its nearest exact
-- opposite-amount inflow on another linked account within 7 days.
pairs AS (
  SELECT o.id AS out_id, m.id AS in_id
  FROM tx o
  CROSS JOIN LATERAL (
    SELECT i.id
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
paired AS (
  SELECT out_id AS id FROM pairs
  UNION
  SELECT in_id FROM pairs
),
-- Each row's counterparty types, or '(none)'. Names are only compared, never returned.
cp_types AS (
  SELECT tx.id,
         COALESCE(cp->>'type', '(none)') AS cp_type,
         CASE WHEN cp IS NULL THEN 'n/a'
              WHEN EXISTS (
                SELECT 1 FROM inst
                WHERE inst."userId" = tx."userId"
                  AND regexp_replace(lower(COALESCE(cp->>'name', '')), '[^a-z0-9]', '', 'g') = inst.norm)
              THEN 'yes' ELSE 'no' END AS cp_matches_linked
  FROM tx
  LEFT JOIN LATERAL jsonb_array_elements(tx.counterparties) cp ON true
),

results AS (
  -- A. Transfers out.
  SELECT 'A transfers out: detailed | counterparty type | matches linked institution? | matched internally?' AS section,
         tx.user_n,
         tx.detailed_cat AS a,
         c.cp_type AS b,
         c.cp_matches_linked AS c,
         CASE WHEN tx.id IN (SELECT id FROM paired) THEN 'internal (matched)' ELSE 'external (no match)' END AS d,
         NULL::text AS e,
         count(*) AS n
  FROM tx JOIN cp_types c ON c.id = tx.id
  WHERE tx.amount > 0 AND tx.primary_cat ~* '^TRANSFER_OUT'
  GROUP BY 2, 3, 4, 5, 6

  UNION ALL
  -- B. OTHER_OTHER.
  SELECT 'B OTHER_OTHER: direction/account | counterparty type | confidence | merchant_name set? | matched internally?',
         tx.user_n,
         CASE WHEN tx.amount > 0 THEN 'out' ELSE 'in' END || ' / ' || tx.account_type
           || CASE WHEN tx.pending THEN ' (pending)' ELSE '' END,
         c.cp_type,
         tx.confidence,
         CASE WHEN tx.has_merchant THEN 'merchant_name yes' ELSE 'merchant_name no' END,
         CASE WHEN tx.id IN (SELECT id FROM paired) THEN 'internal (matched)' ELSE 'not matched' END,
         count(*)
  FROM tx JOIN cp_types c ON c.id = tx.id
  WHERE tx.primary_cat = 'OTHER'
  GROUP BY 2, 3, 4, 5, 6, 7

  UNION ALL
  -- C. Confidence by category.
  SELECT 'C confidence: primary | direction | account | confidence',
         tx.user_n,
         tx.primary_cat,
         CASE WHEN tx.amount > 0 THEN 'out' ELSE 'in' END,
         tx.account_type,
         tx.confidence,
         NULL,
         count(*)
  FROM tx
  GROUP BY 2, 3, 4, 5, 6

  UNION ALL
  -- D. Unpaired card-payment outflows (non-credit account, coded as a credit card
  --    payment, not exactly paired within 7 days): the nearest credit-account inflow
  --    within 31 days, by amount difference then day gap.
  SELECT 'D unpaired card payments: amount difference | day gap | counterparty matches linked? | has a linked credit account?',
         o.user_n,
         CASE WHEN m.diff IS NULL          THEN 'no credit inflow within 31 days'
              WHEN m.diff < 0.01           THEN 'exact (< $0.01)'
              WHEN m.diff <= 1             THEN '<= $1'
              WHEN m.diff <= 10            THEN '<= $10'
              WHEN m.diff <= 0.05 * o.amount THEN '<= 5% of payment'
              ELSE 'larger' END,
         CASE WHEN m.gap IS NULL THEN 'n/a'
              WHEN m.gap <= 7    THEN '0-7 days'
              WHEN m.gap <= 14   THEN '8-14 days'
              ELSE '15-31 days' END,
         CASE WHEN EXISTS (SELECT 1 FROM cp_types c WHERE c.id = o.id AND c.cp_matches_linked = 'yes') THEN 'yes' ELSE 'no' END,
         CASE WHEN EXISTS (SELECT 1 FROM "Account" a WHERE a."userId" = o."userId" AND a.type = 'credit') THEN 'yes' ELSE 'no' END,
         NULL,
         count(*)
  FROM tx o
  LEFT JOIN LATERAL (
    SELECT abs(o.amount + i.amount) AS diff, abs(i.d - o.d) AS gap
    FROM tx i
    WHERE i."userId" = o."userId"
      AND i.account_type = 'credit'
      AND i.amount < 0
      AND abs(i.d - o.d) <= 31
    ORDER BY abs(o.amount + i.amount), abs(i.d - o.d), i.id
    LIMIT 1
  ) m ON true
  WHERE o.amount > 0
    AND o.account_type <> 'credit'
    AND o.detailed_cat = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    AND o.id NOT IN (SELECT out_id FROM pairs)
  GROUP BY 2, 3, 4, 5, 6
)
SELECT section, user_n, a, b, c, d, e, n
FROM results
ORDER BY section, user_n, n DESC, a, b, c, d, e;
