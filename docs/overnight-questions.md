# Overnight run — questions and report (M7.2 PR)

## Report

Branch `m7-2-period-anchor`, 6 commits on top of `main` (`ff62aaa4`). Everything is
pushed. **The PR is not open:** no GitHub CLI is installed here and I have no API
credentials, so it needs one click from you (link below). The PR description is at the end
of this report, ready to paste.

**Full verification on `6e56e405`** (the last code commit; the commit after it only adds
this report), with a clean working tree:
- **Frontend:** typecheck, `CI=true` build and both repros (`repro:url-params`,
  `repro:link-nav`, 11/11) pass.
- **Backend:** typecheck passes and the suite is 113/113 (it was 79 before this run).

**CI:** the new required-check candidate is the job named **`frontend`**. CI only runs on
`pull_request` events and pushes to `main`, so it will run for the first time when you open
the PR.

### What shipped, section by section

| # | Commit | What |
|---|---|---|
| 1 | `f1ed5adc` | **M7.2 period anchor**, built as specced (details below). |
| 2 | `e6415eda` | **Frontend CI job `frontend`:** `npm ci`, typecheck, `CI=true` build, both repros. The lockfile was checked with `npm ci --dry-run`. It runs on Node 24, because the repros depend on Node's built-in TypeScript type stripping. |
| 3 | `442c112b` | **§7 re-verified against the demo seed. None of the four reproduce**, and three can't on any seed date. Fixed nothing. Numbers are in `docs/m7.3-data-trust-notes.md`; the script is `backend/scripts/verify-s7-demo.ts` (read-only, refuses non-local databases). |
| 4 | `0c5df67e` | **The nine remaining reachable writes now go through `readWriteResult`** (Sync, row 1, was already fixed). Each shows the failure at the control and changes nothing locally. Rows are marked fixed in the notes, not deleted. No site needed a new failure-UX decision; all follow the stage 3 bell's pattern. |
| 5 | `6e56e405` | **Accent:** header, nav and bell now use `colors.green` (`#00e87a`); the diff touches only those three colours. **Prisma hole closed:** `backend/prisma.config.ts` refuses `migrate dev` / `migrate reset` / `db push` / `db seed` against non-local URLs however Prisma is invoked. It holds no credentials and was verified without touching production (commit message has the test matrix). Nothing in the notes was marked "mechanical". |

**Section 1 in detail**
- **Setting:** `User.periodStartDay Int @default(1)`, migrated through `db:dev:migrate`. The
  migration only adds the column.
- **Period logic:** `backend/src/lib/period.ts`, pure UTC functions. `tests/period.test.ts`
  covers February with day 28 (including a leap year), year boundaries, and day 1 grouping
  fixture dates exactly like the old `toISOString().slice(0, 7)`.
- **Settings API:** `GET/PUT /user/settings`, whole numbers 1–28 only (a string like `"10"`
  is rejected, not coerced).
  - PUT calls `ensureUser` and is refused in demo mode twice: by middleware and by the
    service.
  - The frontend save goes through `readWriteResult`.
  - CORS now allows PUT. Without that the browser would have blocked the save; this was
    missing.
- **Endpoints:**
  - They read the stored start day themselves; no view passes it in.
  - Cash flow and trends return every period, with empty ones as zero and a `txCount`.
  - Trends' window now starts on a period boundary, which fixes the partial oldest month.
  - Net worth keeps its day ranges and adds `periodMarkers`.
- **Scope, per your decision:** five charts, Insights (summary, top merchants, largest
  purchases, highlights, and the runway's months-of-history count) and the hero's saved
  figure. Budgets, score, goals and alert fingerprints stay calendar-month.
- **Honesty requirement:** in-progress periods say "so far · day X of Y" in the hero,
  Insights summary and highlights, Cash flow cards, tooltip and faded bars, Monthly savings,
  Month over month, and the Monthly Spending delta (plus a hollow last dot). Nothing is
  projected.
- **Frontend plumbing:** `PeriodProvider` above `<Routes>`, next to `SyncProvider`. A
  Settings entry in the Clerk account menu opens a one-control dialog.
- **Demo mode: fixed at day 1.** That's the smaller implementation: no browser-only
  override threaded through every endpoint, and demo has no account menu, so no Settings
  entry.
- **Tests:** `tests/user-settings.test.ts` covers validation, the default for a user with no
  row, isolation, demo refusal, and transactions either side of a day-10 boundary landing in
  different periods (and in calendar months at day 1). Two endpoints were added to the
  isolation read list.

### Parked questions (details, options and recommendations below)

| | Question | My recommendation |
|---|---|---|
| **Q1** | Should Spending breakdown follow the start day? Today it's calendar-month, next to an anchored Month over month. | Anchor it. The code path already exists. |
| **Q2** | Periods before a user's first transaction are $0 bars, and they pull "Avg Monthly Net" and the savings average toward zero. | Draw pre-history as "no data" and exclude it (and the in-progress period) from averages. |
| **Q3** | How to verify §7 against real data without touching production. | You check numbers in the browser from a checklist first; a user-scoped diagnostics endpoint only if needed. |
| **Q4** | `#00e5a0` is still used outside header/nav (demo banner, connect panel, Monthly Spending chart, two cards). | Switch the page chrome to the token now; leave data colours for M7.3. |
| **Q5** | Which Prisma commands the config guard covers (not `migrate resolve`, `db execute`, `studio`). | Keep the current set; confirm Railway's commands. |

### Needs a browser pass from you

**Period anchor**
1. Open Settings from the account menu and change the start day to 10. The hero label, Insights
   title, Cash flow, Monthly savings, Monthly Spending, Month over month and net worth markers all
   change; "so far · day X of Y" appears on the current period.
2. Set it back to 1. Everything should look exactly as it did before this PR.
3. In demo mode there's no Settings entry and everything shows calendar months.

**Charts**
4. Cash flow's faded in-progress bars and zero bars look intentional, not broken.
5. The net worth dashed markers don't clutter the 1M range. The 1Y and All ranges need data you
   may not have yet.

**Write failures (easiest to trigger in demo mode)**
6. Each of these shows its "not saved" / "not added" / "not removed" / "not deleted" message
   and changes nothing: editing a budget limit, deleting a budget, adding a budget, creating
   and deleting a goal, editing a transaction's tags, and Live Balances.
7. Adding a budget in the *Health & Fitness* category while signed in should now show an
   error instead of silently closing (the known category-mismatch bug).

**Styling**
8. Accent green on the nav, bell badge and Sync-in-progress. Check it against the demo
   banner above the header (Q4).

**After merge**
9. Check that Railway's first deploy succeeds with `prisma.config.ts` present (Q5).

### Surprises

- **Prisma stops reading `backend/.env` entirely once a config file exists** (verified:
  "Prisma config detected, skipping environment variable loading"). That's what makes the
  guard airtight, but it also means `npx prisma studio` against production from this laptop
  needs the URL exported in the shell first.
- **The local test database had no migration history** (P3005). It had been built with
  `db push` at some point. I rebuilt it from the migrations with `migrate reset --skip-seed`,
  after the M7.0 guard confirmed it was localhost, and it now matches what CI does.
- **CORS didn't allow PUT.** There had never been a PUT endpoint before this one.
- **§7 couldn't come from the demo at all**, including the Monthly Spending climb: the seed
  has no transfers, card payments or pending transactions. Separately, the seed's own comment
  says the budgets are there "so utilization is real", and it isn't (spend is always $0).
- **Monthly Spending's oldest bar was a partial month before M7.2.** Its cutoff was "exactly
  12 months ago today". The period window fixes this as a side effect.
- **Behaviour change to know about:** future-dated transactions no longer fall into an extra
  bucket in cash flow and trends, because windows now end at the current period's end.

### Open the PR

<https://github.com/PloypairaohPat/finance-dashboard/compare/main...m7-2-period-anchor?expand=1>

Suggested title: **M7.2: period anchor, frontend CI, demo-write fixes, Prisma guard**

<details><summary>PR description (paste into GitHub)</summary>

```markdown
One PR for the M7.2 overnight run. Each section is its own commit.

## 1. M7.2 — configurable period anchor (`f1ed5adc`)
- `User.periodStartDay` (1–28, default 1 = calendar months). Migration adds one column.
- `backend/src/lib/period.ts`: pure UTC period math. Unit tests cover February with day 28
  (including a leap year), year boundaries, and day 1 matching the old calendar grouping
  exactly.
- `GET/PUT /user/settings`: validated to 1–28, PUT calls `ensureUser`, refused in demo, read
  through `readWriteResult`. CORS now allows PUT.
- Anchored: Cash flow, Monthly savings, Monthly Spending, Month over month, Net worth
  (period markers only; day ranges unchanged), Insights, and the hero's saved figure.
  Budgets, score, goals and alert fingerprints stay calendar-month.
- Empty periods show as zero bars. In-progress periods are marked "so far · day X of Y" and
  never projected.
- `PeriodProvider` above `<Routes>`. Settings entry in the account menu, one control.
  Demo mode is fixed at day 1.
- New tests: `period.test.ts`, `user-settings.test.ts`, plus isolation read-list additions.

## 2. Frontend CI (`e6415eda`)
New `frontend` job: `npm ci`, typecheck, `CI=true` build, `repro:url-params`,
`repro:link-nav`. **Add `frontend` to the required checks.**

## 3. §7 re-verification (`442c112b`) — no fixes
None of the four §7 observations reproduce against the demo seed. Results and method are in
`docs/m7.3-data-trust-notes.md`; the read-only script is `backend/scripts/verify-s7-demo.ts`.

## 4. Demo-write inventory (`0c5df67e`)
The nine remaining reachable write sites now read responses through `readWriteResult`.
Failures show at the control and change nothing locally. Inventory rows are marked fixed.

## 5. Small items (`6e56e405`)
- Header, nav and bell accent now use `colors.green`.
- `backend/prisma.config.ts` refuses destructive Prisma commands against non-local
  databases, closing the bare `npx prisma migrate dev` hole. Side effect: the Prisma CLI no
  longer loads `backend/.env`.

## Verification
Frontend typecheck, `CI=true` build, both repros; backend typecheck and 113/113 tests.

## Review notes
Open questions Q1–Q5 are in `docs/overnight-questions.md`. Needs a browser pass (list in the
same file). Check that Railway's first deploy after merge succeeds with `prisma.config.ts`
present.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

</details>

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
