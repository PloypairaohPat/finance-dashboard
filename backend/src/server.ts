// ─────────────────────────────────────────────────────────────────
//  server.ts  —  Plaid Integration Backend
// ─────────────────────────────────────────────────────────────────

import dotenv from 'dotenv'
dotenv.config()

import express, { Request, Response } from 'express'
import cors, { CorsOptions } from 'cors'
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid'
import accountsRouter from './routes/accounts.routes'
import transactionsRouter from './routes/transactions.routes'
import { makeRecurringRouter } from './routes/recurring.routes'
import { makePlaidRouter } from './routes/plaid.routes'
import { getCategories, getCategoryComparison} from './controllers/transactions.controller'
import budgetsRouter from "./routes/budgets.routes"
import alertsRouter from "./routes/alerts.routes"
import networthRouter from "./routes/networth.routes"
import cashflowRouter from "./routes/cashflow.routes"
import { clerkAuth, requireSession } from "./middleware/auth"
import { startScheduler } from "./scheduler"
import insightsRoutes from "./routes/insights.routes"
import subscriptionsRoutes from "./routes/subscriptions.routes"

// ── Env validation ────────────────────────────────────────────────
const REQUIRED_ENV = [
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'ENCRYPTION_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
]

REQUIRED_ENV.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`)
    process.exit(1)
  }
})

// ── Plaid config ──────────────────────────────────────────────────
const plaidEnv = process.env.PLAID_ENV! as keyof typeof PlaidEnvironments

const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
    },
  },
}))

const plaidProducts = (process.env.PLAID_PRODUCTS || 'transactions')
  .split(',').map((p) => p.trim() as Products)

const plaidCountryCodes = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map((c) => c.trim() as CountryCode)

// ── App setup ─────────────────────────────────────────────────────
const app = express()

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    const allowed: (string | RegExp)[] = [
      'http://localhost:3000',
      /https:\/\/finance-dashboard.*\.vercel\.app$/,
    ]

    if (
      !origin ||
      allowed.some((o) =>
        typeof o === 'string' ? o === origin : o.test(origin)
      )
    ) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}

app.use(cors(corsOptions))
app.use(express.json())
app.use(clerkAuth)

// ── Routes ────────────────────────────────────────────────────────
app.use('/accounts', requireSession, accountsRouter)
app.use('/transactions', requireSession, transactionsRouter)
app.use('/recurring', requireSession, makeRecurringRouter(plaidClient))
app.use('/budgets', requireSession, budgetsRouter)
app.use('/alerts', requireSession, alertsRouter)
app.use('/networth', requireSession, networthRouter)
app.use('/cashflow', requireSession, cashflowRouter)
app.get('/categories', requireSession, getCategories)
app.get('/categories/comparison', requireSession, getCategoryComparison)
app.use("/insights", insightsRoutes)
app.use("/subscriptions", subscriptionsRoutes)

// Plaid router still needs route-level auth inside plaid.routes.ts
app.use('/', makePlaidRouter(plaidClient, plaidProducts, plaidCountryCodes))

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) =>
  res.json({ status: 'ok', env: process.env.PLAID_ENV })
)

// ── Start ─────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, () => {
  console.log(`\n🚀 Plaid backend running on http://localhost:${PORT}`)
  console.log(`   Environment: ${process.env.PLAID_ENV}`)
  console.log(`   Products:    ${process.env.PLAID_PRODUCTS}`)
  console.log(`\n   Endpoints:`)
  console.log(`   POST /create_link_token`)
  console.log(`   POST /exchange_public_token`)
  console.log(`   GET  /accounts`)
  console.log(`   GET  /transactions`)
  console.log(`   GET  /categories`)
  console.log(`   GET  /recurring`)
  console.log(`   POST /webhook`)
  console.log(`   GET  /health\n`)
  startScheduler(plaidClient)
})