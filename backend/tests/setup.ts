// ─────────────────────────────────────────────────────────────────
//  tests/setup.ts — M6.1 cross-tenant isolation suite: safety gate
//  + test-only auth/Plaid stubs.
//
//  This file is loaded by vitest (see vitest.config.ts `setupFiles`)
//  BEFORE any test file's own imports run. That ordering is load-bearing:
//  it lets us pin process.env.DATABASE_URL (and friends) before
//  `../src/app` / `../src/lib/prisma` are ever imported, since
//  PrismaClient and the Plaid client are both constructed at module
//  import time.
// ─────────────────────────────────────────────────────────────────

import path from 'node:path'
import dotenv from 'dotenv'
import { vi } from 'vitest'

// ── 1. Load backend/.env.test explicitly — NEVER backend/.env ──────
// `override: true` so .env.test is authoritative even if the ambient shell
// (or a prior dotenv.config() call) already exported DATABASE_URL — e.g.
// from backend/.env. Without this, dotenv's default "don't clobber an
// existing value" behavior could let a pre-set real DATABASE_URL slip
// past this file entirely.
const envTestPath = path.resolve(__dirname, '..', '.env.test')
const loaded = dotenv.config({ path: envTestPath, override: true })

if (loaded.error) {
  throw new Error(
    `[M6.1 isolation suite] Could not load ${envTestPath} — refusing to run.\n` +
      `Create backend/.env.test with DATABASE_URL/DIRECT_URL pointing at a disposable ` +
      `test Postgres database before running this suite (see backend/.env.test's own ` +
      `header comment for the local docker command used to provision one).\n` +
      `Underlying error: ${loaded.error.message}`,
  )
}

// ── 2. Parse the REAL .env's DATABASE_URL in isolation, for comparison only ──
// (parsed into a throwaway object — never merged into process.env)
const realEnvPath = path.resolve(__dirname, '..', '.env')
const realParsed = dotenv.config({ path: realEnvPath, processEnv: {} }).parsed ?? {}
const realDatabaseUrl = realParsed.DATABASE_URL

function maskCredentials(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return `${u.protocol}//${u.hostname}:${u.port || '(default)'}${u.pathname}`
  } catch {
    return '(unparseable DATABASE_URL — refusing to print raw value)'
  }
}

// ── 3. Hard-fail unless DATABASE_URL clearly targets a test database ───
const testDatabaseUrl = process.env.DATABASE_URL

if (!testDatabaseUrl) {
  throw new Error(
    '[M6.1 isolation suite] DATABASE_URL is not set after loading backend/.env.test — refusing to run.',
  )
}

if (realDatabaseUrl && testDatabaseUrl === realDatabaseUrl) {
  throw new Error(
    "[M6.1 isolation suite] backend/.env.test's DATABASE_URL is IDENTICAL to backend/.env's " +
      'DATABASE_URL. Refusing to run a suite that seeds and deletes data against what may be ' +
      'the production database.',
  )
}

let parsedTestUrl: URL
try {
  parsedTestUrl = new URL(testDatabaseUrl)
} catch {
  throw new Error(
    `[M6.1 isolation suite] DATABASE_URL is not a valid URL — refusing to run. ` +
      `Got: ${maskCredentials(testDatabaseUrl)}`,
  )
}

const host = parsedTestUrl.hostname.toLowerCase()
const dbName = parsedTestUrl.pathname.replace(/^\//, '').toLowerCase()

if (!host.includes('test') && !dbName.includes('test')) {
  throw new Error(
    `[M6.1 isolation suite] Neither the DATABASE_URL host ("${host}") nor the database name ` +
      `("${dbName}") contains "test" — refusing to run against what doesn't clearly look like ` +
      `a test database. Target was: ${maskCredentials(testDatabaseUrl)}`,
  )
}

// eslint-disable-next-line no-console
console.log(`[M6.1 isolation suite] Target test database: ${maskCredentials(testDatabaseUrl)}`)

// ── 4. Dummy values app.ts requires (process.exit(1)s otherwise) ───────
// `??=` so a real value already present in .env.test (or the environment)
// always wins over these test-only placeholders.
process.env.PLAID_CLIENT_ID ??= 'test-plaid-client-id'
process.env.PLAID_SECRET ??= 'test-plaid-secret'
process.env.PLAID_ENV ??= 'sandbox'
// Must be exactly 32 bytes (64 hex chars) — utils/encrypt.ts uses aes-256-gcm.
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32)
process.env.CLERK_SECRET_KEY ??= 'sk_test_dummy_isolation_suite'
process.env.CLERK_PUBLISHABLE_KEY ??= 'pk_test_dummy_isolation_suite'

// ── 5. Auth stub — mock ONLY Clerk's token verification ────────────────
// Everything downstream of this (requireSession, demoReadOnly, getUserId,
// every route/controller/service, every Prisma call) is the REAL,
// unmodified app code from src/. A request "authenticates" as a given
// test user purely via the `X-Test-User` header, which getAuth() below
// reads instead of verifying a real Clerk session token.
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  getAuth: (req: any) => ({ userId: req.header('X-Test-User') || null }),
}))

// ── 6. Plaid stub — NOT part of the isolation logic under test ─────────
// Several endpoints (/recurring, /subscriptions, /transactions/categories,
// GET /alerts) call plaidClient.transactionsRecurringGet() for every user
// that has a PlaidItem. Left unmocked, that's a real network call to
// Plaid's API using placeholder credentials — slow/flaky at best, and a
// suite that seeds fixtures with fake PlaidItems should never depend on
// external network reachability. Only the Plaid SDK's HTTP methods are
// stubbed; Configuration/PlaidEnvironments/Products/CountryCode (used by
// src/app.ts and src/lib/plaidClient.ts to build client config) pass
// through untouched via importOriginal.
vi.mock('plaid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('plaid')>()
  const empty = { data: { outflow_streams: [], inflow_streams: [] } }
  class MockPlaidApi {
    transactionsRecurringGet = vi.fn().mockResolvedValue(empty)
    transactionsSync = vi.fn().mockResolvedValue({
      data: { added: [], modified: [], removed: [], has_more: false, next_cursor: 'test-cursor' },
    })
    accountsGet = vi.fn().mockResolvedValue({ data: { accounts: [] } })
    accountsBalanceGet = vi.fn().mockResolvedValue({ data: { accounts: [] } })
    linkTokenCreate = vi.fn().mockResolvedValue({ data: { link_token: 'link-test-token' } })
    itemGet = vi.fn().mockResolvedValue({ data: { item: { institution_id: null } } })
    itemPublicTokenExchange = vi
      .fn()
      .mockResolvedValue({ data: { access_token: 'test-access-token', item_id: 'test-item-id' } })
    institutionsGetById = vi.fn().mockResolvedValue({ data: { institution: { name: 'Test Bank' } } })
  }
  return { ...actual, PlaidApi: MockPlaidApi }
})
