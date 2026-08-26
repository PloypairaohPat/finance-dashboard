# Ledger — Personal Finance Dashboard

A full-stack personal finance platform that connects to a real bank via **Plaid Production**, normalizes and enriches transactions through a custom TypeScript pipeline, and surfaces actionable financial intelligence — budgets, subscription detection, a 7-detector alerts engine, goals, and a composite 0–100 Financial Health Score.

**🔗 [Live demo — no login required](https://finance-dashboard-tau-two.vercel.app/?demo=1)** · Explore the full dashboard instantly with realistic sample data — no sign-up. Or [sign in with Clerk](https://finance-dashboard-tau-two.vercel.app) to connect a real bank.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-43853D?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?logo=postgresql&logoColor=white)
![Plaid](https://img.shields.io/badge/Plaid-000000?logo=plaid&logoColor=white)
![Clerk](https://img.shields.io/badge/Clerk-6C47FF?logo=clerk&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-black?logo=vercel)
![Railway](https://img.shields.io/badge/Railway-131415?logo=railway&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)

---

## Overview

I built Ledger to learn how a modern fintech stack fits together end-to-end — bank API integration, encryption at rest, transaction normalization, recurring detection, alerting, goal tracking — while delivering something I actually use daily.

The app pulls live transactions from my Wells Fargo accounts through Plaid Production, runs them through a TypeScript cleaning pipeline (regex + alias map + pending-resolver), stores them in PostgreSQL via Prisma, and renders a polished React dashboard with seven alert detectors, subscription-price-change detection, and a weighted financial health score. A `node-cron` job re-syncs daily at 06:00 UTC and snapshots account balances for net-worth trending.

**Built incrementally across 5 phases, ~6 months, 71+ commits.**

---

## Screenshots

| Hero Overview | Spending Donut | Net Worth Trend |
| :---: | :---: | :---: |
| ![Hero Overview](assets/screenshots/hero-overview.png) | ![Spending Donut](assets/screenshots/spending-donut.png) | ![Net Worth Trend](assets/screenshots/net-worth.png) |

| Subscriptions | Smart Alerts | Goals + Health Score |
| :---: | :---: | :---: |
| ![Subscriptions](assets/screenshots/subscriptions.png) | ![Smart Alerts](assets/screenshots/alerts.png) | ![Goals + Health Score](assets/screenshots/goals-health.png) |

---

## Features

### Banking & sync
- **Plaid Production** integration with Wells Fargo — `/transactions/sync`, Recurring Transactions product, balance fetch
- **Daily cron sync** via `node-cron` — runs at 06:00 UTC, syncs transactions, snapshots balances
- **Cursor pagination** on transactions — handles unbounded history without re-fetching
- **Incremental updates only** — persisted Plaid sync cursor per item

### Intelligence
- **7-detector Smart Alerts engine** — large transactions, new merchants, monthly pace, budget exceeded, low balance, missed paycheck, subscription price-up
- **Subscription detection** from Plaid recurring streams + heuristic confirmation
- **Composite Financial Health Score** (0–100) weighted across savings rate, spend control, debt load, growth trend
- **Goal tracking** — 4 types (savings, emergency fund, vacation/purchase, debt payoff)
- **Monthly insights** — summary, runway, top merchants, largest purchases
- **Projected-overspend warnings** — budgets warn you *before* you blow the limit, not after

### UX
- **Installable PWA** (iOS + Android home screen)
- **Mobile-responsive** down to 375px
- **Skeleton loaders** — no spinner jank
- **Design token system** + unified chart theme (single source of truth for colors, sizes, motion)
- **Empty-state copy** hand-tuned for every state

---

## Architecture

```
                                  ┌─────────────────┐
                                  │  Plaid Prod API │
                                  │  (Wells Fargo)  │
                                  └────────┬────────┘
                                           │ /transactions/sync
                                           │ /transactions/recurring/get
                                           │ /accounts/balance/get
                                           ▼
┌──────────────┐   HTTPS    ┌──────────────────────────────┐    SQL    ┌──────────────┐
│ React SPA    │◀──────────▶│  Node.js + Express + Prisma  │◀─────────▶│  PostgreSQL  │
│ (Vercel)     │  Clerk JWT │  (Railway)                   │           │  (Supabase)  │
│              │            │                              │           │              │
│ • Recharts   │            │  • Plaid sync service        │           │  • User      │
│ • Skeletons  │            │  • Normalizer + cleaner      │           │  • PlaidItem │
│ • Tokens     │            │  • 7 alert detectors         │           │  • Account   │
│ • PWA        │            │  • Subscription detector     │           │  • Tx        │
│ • Clerk SDK  │            │  • Score engine              │           │  • Budget    │
└──────────────┘            │  • node-cron daily sync      │           │  • Alert     │
                            └──────────────────────────────┘           │  • Goal      │
                                           │                            │  • Snapshot  │
                                           │ AES-256-GCM                └──────┬───────┘
                                           ▼                                   │
                                  ┌─────────────────┐                          │
                                  │ Encrypted Plaid │                          │ psycopg2
                                  │ access tokens   │                          ▼
                                  └─────────────────┘                  ┌──────────────┐
                                                                       │ JupyterLab   │
                                                                       │ (local-only) │
                                                                       │ pandas + d3  │
                                                                       └──────────────┘
```

---

## Engineering Highlights

### Security model
- **AES-256-GCM encryption** for Plaid access tokens at rest. The 32-byte key lives in Railway environment variables only; tokens are encrypted before insert and decrypted on demand inside the Plaid service. Tokens are never logged, never returned in API responses, and never written to disk in plaintext.
- **Clerk JWT authentication** end-to-end. Every backend route is wrapped in middleware that verifies the Clerk JWT and resolves it to a `userId` before any service-layer call. The original hardcoded `demo-user` auth-bypass was removed in Phase 4; the current demo mode (below) is a deliberately isolated, read-only account, not an auth shortcut.
- **Per-user data isolation** — every Prisma query is scoped to a server-resolved `userId`, never one supplied in a request param or body. For authenticated users that id comes from the verified Clerk JWT; the only other path, read-only demo mode, resolves to a single fixed public user. No request can name whose data to read.
- **Read-only demo mode** — an `X-Demo-Mode` header maps a request to one pre-seeded demo user with entirely synthetic data. A global guard blocks every mutating request (and every Plaid call) for it, so it exposes no real financial data and can never resolve to a real account — it exists purely so the dashboard can be explored without a login.
- **Secrets posture** — `.env` files gitignored; production secrets live only in Railway/Vercel/Supabase/Clerk dashboards. The Python analytics environment connects directly to Supabase via a separate read connection and is never deployed.

### Data pipeline
Every sync runs the same chain:

1. **`/transactions/sync`** is called with the per-item persisted cursor — incremental only.
2. **Normalizer** (`utils/normalizer.ts`) — regex + alias map strips Plaid noise (`"SQ *COFFEE BAR 1234 BROOKLYN NY"` → `"Coffee Bar"`) and maps to a canonical merchant name.
3. **Pending resolver** (`utils/pendingResolver.ts`) — reconciles pending → posted transactions using Plaid's transaction IDs, with a fuzzy fallback on amount + date + merchant when IDs change.
4. **Cleaner** (`services/cleaner.ts`) — runs after every sync to backfill normalized fields on any historical rows that were missed.
5. **Display category map** (`lib/categoryMap.ts`) — collapses Plaid's ~80 raw categories into 10 readable display categories (Housing, Food & Dining, Transportation, etc.).

### Smart Alerts — 7 detectors
Each detector is a pure function over the user's transaction history. They live in `backend/src/services/alerts/detectors/` with thresholds at the top of each file for easy tuning:

| Detector | Trigger |
| --- | --- |
| Large transaction | Amount > 2× user's trailing average for that category |
| New merchant | First-ever transaction at a merchant, amount > $50 |
| Monthly pace | Projected month-end spend > 120% of prior month |
| Budget exceeded | Category spend > user's budget for that month |
| Low balance | Account balance projected to drop below threshold before next paycheck |
| Missed paycheck | Expected recurring inflow late by > N days |
| Subscription price-up | Recurring stream amount increased > 10% MoM |

All 7 run on `GET /alerts` (~1–2s end-to-end). Results are persisted in the `Alert` table so dismissals survive across sessions.

### Financial Health Score
A weighted composite over 4 components, defined in `services/score.service.ts`. Weights are constants at the top of the file for easy tuning:

| Component | Weight | Measures |
| --- | --- | --- |
| Savings rate | 30% | `(income − expenses) / income`, trailing 3-month average |
| Spend control | 25% | % of budgets under-target this month |
| Debt load | 25% | Credit utilization + payoff trajectory |
| Growth trend | 20% | Net-worth slope over trailing 6 months |

Final score is clamped to 0–100. A breakdown card on the dashboard surfaces each component so the number is explainable, not a black box.

---

## Tech Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | React + TypeScript (CRA) | Familiar, fast iteration |
| Charts | Recharts | Composable, themeable, fits the dark aesthetic |
| Auth | Clerk | Drop-in JWT + UI, removed need to build auth from scratch |
| Backend | Node.js + Express + TypeScript | One language across the stack |
| ORM | Prisma | Type-safe queries, migrations as code |
| Database | PostgreSQL (Supabase) | Free tier, easy SQL editor for ad-hoc analysis |
| Bank API | Plaid Production | Industry standard for US banking |
| Encryption | AES-256-GCM (Node `crypto`) | Authenticated encryption for tokens at rest |
| Scheduling | `node-cron` | Daily 06:00 UTC sync + balance snapshots |
| Analytics | Python 3, pandas, psycopg2, matplotlib, JupyterLab | Local ad-hoc analysis on production data |
| Hosting | Vercel + Railway + Supabase | Free-tier production deploy |

---

## Database Schema (key models)

```prisma
model User {
  id           String        @id @default(cuid())
  email        String?
  createdAt    DateTime      @default(now())
  plaidItems   PlaidItem[]
  accounts     Account[]
  transactions Transaction[]
  budgets      Budget[]
  alerts       Alert[]
  goals        Goal[]
}

model PlaidItem {
  id              String    @id @default(cuid())
  userId          String
  itemId          String    @unique
  accessToken     String    // AES-256-GCM encrypted
  institutionName String?
  cursor          String?   // /transactions/sync cursor
  lastSyncedAt    DateTime?
  // ...
}

model Account {
  id               String   @id @default(cuid())
  plaidAccountId   String   @unique
  type             String
  subtype          String?
  currentBalance   Decimal? @db.Decimal(12, 2)
  availableBalance Decimal? @db.Decimal(12, 2)
  snapshots        BalanceSnapshot[]
  // ...
}

model Transaction {
  id              String    @id @default(cuid())
  plaidTxId       String    @unique
  amount          Decimal   @db.Decimal(12, 2)
  date            DateTime
  merchantName    String?   // normalized
  rawName         String    // Plaid original
  plaidCategory   String?
  displayCategory String?   // collapsed via categoryMap
  pending         Boolean
  tags            String[]
  notes           String?
  deletedAt       DateTime?
}

model BalanceSnapshot {
  id        String   @id @default(cuid())
  accountId String
  balance   Decimal  @db.Decimal(12, 2)
  date      DateTime
  type      String   // "current" | "available"
}

model Budget { /* userId, category, monthlyLimit, month */ }
model Alert  { /* userId, type, payload, dismissedAt */ }
model Goal   { /* userId, type, target, current, deadline */ }
```

---

## API Reference

```
# Plaid Link
POST   /plaid/link/token         create Plaid Link token for user
POST   /plaid/exchange           exchange public_token for access_token

# Core data
GET    /accounts                 all linked accounts + balances
GET    /transactions             paginated, filterable
GET    /transactions/trends      monthly totals
GET    /transactions/search      cursor-paginated search

# Analytics
GET    /categories/list          current-month category breakdown
GET    /categories/comparison    MoM (?months=3)
GET    /cashflow                 income vs expenses by month
GET    /net-worth                assets / liabilities / net by month
GET    /insights                 summary, runway, top merchants, largest

# Recurring + subscriptions
GET    /recurring                Plaid recurring streams
GET    /subscriptions            detected subscriptions + upcoming bills

# Budgets
GET    /budgets                  with current spend + status
POST   /budgets                  create/update
GET    /budgets/status           over/under summary

# Alerts
GET    /alerts                   run 7 detectors
POST   /alerts/:id/dismiss
GET    /alerts/digest            weekly digest

# Goals + score
GET    /goals
POST   /goals
PATCH  /goals/:id
DELETE /goals/:id
GET    /score                    composite 0–100
```

---

## Project Structure

```
finance-dashboard/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   └── src/
│       ├── controllers/              # thin HTTP layer
│       ├── routes/                   # Express routers
│       ├── services/                 # business logic
│       │   ├── alerts/detectors/     # the 7 alert detectors
│       │   ├── plaid.service.ts
│       │   ├── plaidSync.ts
│       │   ├── cleaner.ts
│       │   ├── subscriptions.service.ts
│       │   └── score.service.ts
│       ├── lib/                      # categoryMap, merchantLogos, prisma
│       ├── utils/                    # encrypt, normalizer, pendingResolver
│       ├── scheduler.ts              # node-cron daily sync
│       └── server.ts
├── frontend/
│   └── src/
│       ├── App.tsx
│       ├── tokens.ts                 # design tokens (M5.10)
│       ├── chartTheme.tsx            # unified Recharts theme
│       ├── Skeleton.tsx              # 4 preset skeleton variants
│       ├── MerchantAvatar.tsx
│       ├── HeroOverview.tsx
│       ├── SpendingChart.tsx
│       ├── TrendChart.tsx
│       ├── NetWorthChart.tsx
│       ├── BudgetCard.tsx
│       ├── AlertsList.tsx
│       ├── GoalsList.tsx
│       ├── FinancialScoreCard.tsx
│       └── ...
└── analytics/
    ├── db.py                         # psycopg2 connection
    └── spending_analysis.ipynb       # local-only
```

---

## Development Roadmap

Each phase had an explicit milestone roadmap and acceptance criteria before any code shipped.

| Phase | Theme | Highlights |
| --- | --- | --- |
| **Phase 1** | MVP | Plaid sandbox → production, basic React dashboard, Wells Fargo connected, deployed to Vercel/Railway/Supabase |
| **Phase 2** | Engineering rigor | Full TypeScript migration, routes/controllers/services refactor, data cleaning pipeline, monthly trend analytics, Python analytics environment |
| **Phase 3** | Personal finance core | Budget system, smart alerts v1, transaction search + tagging, net-worth tracking, cash-flow analysis, mobile responsive |
| **Phase 4** | Production hardening | Clerk authentication, PWA (installable), centralized API config, daily cron sync + balance snapshots |
| **Phase 5** | Intelligence + polish | Hero overview, redesigned spending donut, budgeting 2.0, insights dashboard, subscription detection, transaction UX rebuild, smart alerts 2.0 (7 detectors), goals + 0–100 financial score, design token system |

**Phase 6 (in progress):** security/isolation hardening, a read-only public demo mode (no-login sample data), custom domain, Hetzner VPS migration.

---

## Local Setup

**Prereqs:** Node 20+, Python 3.11+ (optional, for analytics), PostgreSQL (or a Supabase project), Plaid sandbox keys, Clerk dev keys.

```bash
# 1. Clone
git clone https://github.com/PloypairaohPat/finance-dashboard.git
cd finance-dashboard

# 2. Backend
cd backend
cp .env.example .env          # DATABASE_URL, PLAID_*, CLERK_*, ENCRYPTION_KEY
npm install
npx prisma generate
npx prisma migrate dev
npm run dev                   # http://localhost:4000

# 3. Frontend (new terminal)
cd ../frontend
cp .env.example .env          # REACT_APP_API_URL, REACT_APP_CLERK_PUBLISHABLE_KEY
npm install
npm start                     # http://localhost:3000

# 4. (optional) Analytics
cd ../analytics
python3 -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
jupyter lab
```

> `ENCRYPTION_KEY` must be a 32-byte hex string. Generate one with:
> ```bash
> openssl rand -hex 32
> ```

---

## Disclaimer

This is a personal project handling my own bank data. Account access is gated behind Clerk authentication; the public deploy contains no third-party financial data. Not affiliated with Plaid, Clerk, Wells Fargo, or any institution shown.

---

## License

MIT
