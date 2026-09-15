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
