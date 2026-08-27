// ─────────────────────────────────────────────────────────────────
//  app.ts  —  Plaid Integration Backend (Express app construction)
// ─────────────────────────────────────────────────────────────────

import dotenv from 'dotenv'
dotenv.config()

import express, { Request, Response } from 'express'
import cors, { CorsOptions } from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
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
import { clerkAuth, requireSession, demoReadOnly } from "./middleware/auth"
import prisma from "./lib/prisma"
import insightsRoutes from "./routes/insights.routes"
import subscriptionsRoutes from "./routes/subscriptions.routes"
import goalsRoutes from "./routes/goals.routes"
import scoreRoutes from "./routes/score.routes"

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer
    }
  }
}

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

// Required for correct client IPs behind Railway's proxy — without this,
// req.ip (and therefore rate limiting) would see Railway's edge IP for
// every request instead of the real client, collapsing all users into one bucket.
app.set('trust proxy', 1)

const allowedOrigins: (string | RegExp)[] = [
  'http://localhost:3000',
  'http://localhost:5173',
]
// ALLOWED_ORIGIN env var takes precedence; falls back to regex matching all
// finance-dashboard Vercel preview/production deploys.
const envOrigin = process.env.ALLOWED_ORIGIN
if (envOrigin) {
  allowedOrigins.push(envOrigin)
} else {
  allowedOrigins.push(/https:\/\/finance-dashboard.*\.vercel\.app$/)
}

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (
      !origin ||
      allowedOrigins.some((o) =>
        typeof o === 'string' ? o === origin : o.test(origin)
      )
    ) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Demo-Mode'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
}

// Explicitly terminate preflight OPTIONS before any auth middleware runs.
// Without this, complex requests (Authorization header, PATCH/DELETE) can
// leak into clerkAuth before CORS headers are written.
app.options('*', cors(corsOptions))
app.use(cors(corsOptions))
// crossOriginResourcePolicy is relaxed to cross-origin so the Vercel frontend can
// still fetch from this API; no CSP is set since this is a JSON API, not a page.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))
app.use(express.json({
  verify: (req, _res, buf) => { (req as any).rawBody = buf }
}))
app.use(clerkAuth)
app.use(demoReadOnly)

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 150,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again shortly.' },
  // GET /health must stay available for uptime checks and the DB keepalive.
  // POST /webhook may legitimately burst from Plaid's servers and is already
  // protected by JWT signature verification (M6.3).
  skip: (req) =>
    (req.method === 'GET' && req.path === '/health') ||
    (req.method === 'POST' && req.path === '/webhook'),
})
app.use(generalLimiter)

// Plaid endpoints cost real money and quota per call, so they get a tighter
// limit in addition to the general one above.
const plaidLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again shortly.' },
})

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
app.use("/goals", goalsRoutes)
app.use("/score", scoreRoutes)

app.use(
  ['/create_link_token', '/create-update-link-token', '/exchange_public_token', '/sync'],
  plaidLimiter
)

// Plaid router still needs route-level auth inside plaid.routes.ts
app.use('/', makePlaidRouter(plaidClient, plaidProducts, plaidCountryCodes))

// ── Health ────────────────────────────────────────────────────────
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    res.json({ status: 'ok', db: 'ok' })
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unreachable' })
  }
})

export { app, plaidClient }
