# Overnight run — questions and report (M7.2 PR)

*The report is added at the top of this file in section 6. Parked questions are
collected below as each section runs.*

## Parked questions

### Q1 · Section 1 — Should "Spending breakdown" follow the period start day?

**What I found.** Your scope decision anchors the five charts, Insights and the
hero's saved figure, and keeps budgets, score, goals and alert fingerprints on
calendar months. The Overview's **Spending breakdown** panel (`GET /categories`
→ `fetchCategorySpend`, fed to `SpendingChart` through App) is in neither list. I
built to the letter and left it on the **calendar month**.

The catch: it sits in the same row as **Month over month**, which is now
anchored. With a start day of 10, the left panel shows September 1–30 and the
right panel's "current" column shows Sep 10 – Oct 9, side by side, with no label
saying they differ. That is the same number-disagreement pattern that made you
include the hero.

**Options.**
- **(a) Anchor it too.** `fetchCategorySpend` already takes a window after this PR;
  `getCategories` would pass the current period's. Small change, consistent row.
- **(b) Keep it calendar-month but label it** ("September · calendar month"), so
  the difference is visible.
- **(c) Leave it as shipped.**

**Recommendation: (a).** It's the same argument you made for the hero, and the code
path already exists.

### Q2 · Section 1 — Zero bars before a user's first transaction, and averages

**What I found.** Per your decision, every period in a window is returned, and
periods with no transactions are zero bars rather than skipped. That is right for
a gap *inside* someone's history. It also applies to periods **before their first
transaction** — a user who linked a bank two months ago now sees four $0 periods
in the six-period Cash flow chart, which reads as "you had no income and no
spending," not "no data yet."

It also feeds averages that already existed:
- Cash flow's **Avg Monthly Net** card divides by all six periods.
- Monthly savings' **N-month avg** does the same.

Both now include pre-history zeros, which pulls the average toward zero. Both also
already included the **in-progress** period at its partial value before M7.2; that
is unchanged, but it is the same kind of distortion.

The API marks empty periods (`txCount: 0`), so any of the options below is a
frontend-only change.

**Options.**
- **(a) Leave as shipped:** zeros everywhere, averages over the whole window.
- **(b) Zero-fill only from the first period with data:** true gaps stay visible;
  pre-history periods are omitted.
- **(c) Keep pre-history periods but draw them as "no data"** (hatched or labelled)
  and exclude them — and optionally the in-progress period — from averages.

**Recommendation: (c),** excluding the in-progress period from averages too. It keeps
every gap visible, never presents "no data" as "$0", and stops both averages from
being distorted. (b) is the smaller change if you'd rather not touch chart styling.

### Q3 · Section 3 — How should §7 be verified against real data?

**What I found.** All four §7 observations fail to reproduce against the demo seed; three
can't reproduce from it on any date (details and numbers in
`docs/m7.3-data-trust-notes.md`, *§7 re-verified against the demo seed*). So ground rule 1
can't be met from demo data. Each observation needs a named real account — which means
production data, which I don't touch. This is a method decision for M7.3, not something to
guess tonight.

**Options.**
- **(a) You read the numbers in the browser**, on your own account, from a short
  checklist I write: which card, which month, which figure to compare with which. No new
  code, and nobody touches the database. Slow, and limited to what the UI shows.
- **(b) A signed-in diagnostics endpoint** (e.g. `GET /debug/metrics?period=…`) that
  returns, *for the caller only*, each figure's components side by side: pending included
  or not, transfers filtered or not, subscription override. You open it in your browser.
  It is read-only and user-scoped like every other endpoint, but it's new API surface on a
  finance app, so it should get an isolation test and be removed or admin-gated
  afterwards.
- **(c) A local copy of one real account's rows** in the dev database. The most thorough
  option, but it puts real bank data on a laptop, and nothing in M7.0's rules covers doing
  that safely.

**Recommendation: (a) first, then (b) only for the observations (a) can't settle.**
(a) costs no code and no new risk. (c) I'd avoid.

### Q4 · Section 5 — The second green outside the header and nav

**What I found.** You asked me to pick the token and bring the header and nav in line.
Done: the nav's active state, the alerts bell's count badge and the header's
Sync-in-progress state now use `colors.green` (`#00e87a`). But `#00e5a0` appears in many
more places than the header and nav:

- `App.tsx`: the demo banner (it sits directly above the header), the connect panel's
  checklist dots and "Connect Bank Account" button (including its `#00c98d` hover), and
  the "View demo" button on the sign-in screen.
- `TrendChart.tsx`: the whole Monthly Spending line, its fill, dots and tooltip.
- `AccountCard.tsx`: highlighted balances.
- `TransactionCard.tsx`: incoming amounts.

I left all of these alone: they're outside "header/nav", and changing chart colours isn't
a mechanical swap. The two greens are close but visibly different side by side, most
noticeably the demo banner directly above the now-token-green header.

**Options.**
- **(a) Replace every `#00e5a0` with the token.** Consistent; changes the demo banner,
  connect panel, one chart and two cards.
- **(b) Replace only the chrome** (demo banner, connect panel, sign-in button) and leave
  data colours for M7.3.
- **(c) Leave as shipped.**

**Recommendation: (b).** The banner-above-header mismatch is what's visible on every
demo page. Data colours deserve a deliberate pass.

### Q5 · Section 5 — Which Prisma commands the new config guard should cover

**What I found.** `backend/prisma.config.ts` now refuses `migrate dev`, `migrate reset`,
`db push` and `db seed` against any non-local database. That is exactly what the M7.0
npm guard protects, plus `db push`, which the README already forbids. It deliberately
does **not** cover:

- `migrate resolve`, which writes the migration history table. It's a legitimate
  production repair step: M6 used this kind of history repair.
- `db execute`, which runs arbitrary SQL.
- `studio`, which can edit rows.

Those three can each be a legitimate thing to do to production on purpose, so blocking
them is a policy choice, not a mechanical fix.

**Also worth knowing** (verified, not guessed): with a config file present, Prisma 6.11
**stops loading `backend/.env` for every CLI command** ("Prisma config detected, skipping
environment variable loading"). So `npx prisma studio` or `npx prisma migrate status`
against production from this laptop no longer work without exporting the variables in
the shell first. `migrate deploy`, as Railway and CI run it with injected env vars, is
unaffected. I checked the CI path locally, but **Railway's deploy settings aren't in the
repo, so the first deploy after merge is the real test.**

**Options.**
- **(a) Keep the current set.**
- **(b) Add `db execute` and `studio`**, and leave `migrate resolve` for deliberate repairs.
- **(c) Add all three**, and do deliberate production operations by temporarily
  exporting the URLs and removing the guard, or through an explicit escape hatch.

**Recommendation: (a) for now, and confirm Railway's build and start commands** don't run a
guarded command. An escape hatch is exactly the kind of bypass the M7.0 guard avoided on
purpose.
