// ─────────────────────────────────────────────────────────────────
//  scripts/guard-local-db.ts — M7.0 destructive-command safety gate.
//
//  Runs as a `pre*` npm script before any migrate/reset/seed that can
//  write schema or delete rows. Refuses to let the command proceed
//  unless EVERY Postgres URL Prisma might connect through points at
//  localhost.
//
//  Modeled on the isolation suite's gate in tests/setup.ts.
//
//  Why all three URLs, not just DATABASE_URL: prisma/schema.prisma
//  declares `directUrl` and `shadowDatabaseUrl`, and Prisma Migrate
//  connects through DIRECT_URL — not DATABASE_URL — when one is set.
//  A localhost DATABASE_URL paired with a leftover Supabase DIRECT_URL
//  would still migrate production. The shadow database gets dropped and
//  recreated wholesale by `migrate dev`, so it is if anything the most
//  destructive of the three.
//
//  Fails closed: any missing, unparseable, or non-localhost value is a
//  refusal. There is no bypass flag — that is the point.
// ─────────────────────────────────────────────────────────────────

import path from 'node:path'
import dotenv from 'dotenv'

// Loopback only. Note "localhost.evil.com" must NOT match, so this is an
// exact-set membership test, never a substring check.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// DATABASE_URL and DIRECT_URL are required; the shadow DB is only needed by
// `migrate dev`, but if it IS set it must be local like the others.
const REQUIRED_VARS = ['DATABASE_URL', 'DIRECT_URL'] as const
const OPTIONAL_VARS = ['SHADOW_DATABASE_URL'] as const

function fail(message: string): never {
  console.error(`\n[M7.0 local-db guard] REFUSING TO RUN.\n${message}\n`)
  process.exit(1)
}

/** Print host/port/database only — never user, password, or query string. */
function mask(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return `${u.protocol}//${u.hostname}:${u.port || '(default)'}${u.pathname}`
  } catch {
    return '(unparseable URL — refusing to print raw value)'
  }
}

// The real .env is parsed into a throwaway object, never merged into
// process.env, so reading it here can't contaminate the command we guard.
const realEnvPath = path.resolve(__dirname, '..', '.env')
const realEnv = dotenv.config({ path: realEnvPath, processEnv: {} }).parsed ?? {}

function assertLocal(varName: string, value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    fail(`${varName} is not a valid URL. Got: ${mask(value)}`)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    fail(
      `${varName} does not point at localhost.\n` +
        `  Target: ${mask(value)}\n` +
        `  Host "${hostname}" is not one of: ${[...LOCAL_HOSTNAMES].join(', ')}\n\n` +
        `Destructive Prisma commands are only ever allowed against the local dev\n` +
        `database. Start it with "npm run db:dev:up" and make sure you are running\n` +
        `through the db:dev:* scripts, which load backend/.env.dev.`,
    )
  }

  // Defense in depth: even a localhost URL is refused if it is byte-identical
  // to what backend/.env uses, since that file is the production config.
  for (const [realKey, realValue] of Object.entries(realEnv)) {
    if (realValue && realValue === value) {
      fail(
        `${varName} is IDENTICAL to ${realKey} in backend/.env, which is the\n` +
          `production configuration. Refusing to run a destructive command against it.\n` +
          `  Target: ${mask(value)}`,
      )
    }
  }
}

const checked: string[] = []

for (const varName of REQUIRED_VARS) {
  const value = process.env[varName]
  if (!value) {
    fail(
      `${varName} is not set.\n\n` +
        `Copy backend/.env.dev.example to backend/.env.dev and run this through the\n` +
        `db:dev:* npm scripts, which load it via dotenv-cli.`,
    )
  }
  assertLocal(varName, value)
  checked.push(`${varName} -> ${mask(value)}`)
}

for (const varName of OPTIONAL_VARS) {
  const value = process.env[varName]
  if (!value) continue
  assertLocal(varName, value)
  checked.push(`${varName} -> ${mask(value)}`)
}

console.log(`[M7.0 local-db guard] OK — all targets are local:`)
for (const line of checked) console.log(`  ${line}`)
