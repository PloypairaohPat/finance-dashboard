// ─────────────────────────────────────────────────────────────────
//  prisma.config.ts — refuse destructive Prisma commands against any
//  non-local database, however they are invoked.
//
//  M7.0 wired scripts/guard-local-db.ts as a `pre` npm script, so the
//  db:dev:* scripts can't reach production. It could not catch a bare
//  `npx prisma migrate dev`: that path never runs the npm pre-script and reads
//  backend/.env, which holds the production DATABASE_URL. The Prisma CLI
//  evaluates this file on every command, so the same check now applies no
//  matter how Prisma is started.
//
//  Guarded: `migrate dev`, `migrate reset`, `db seed` (what the M7.0 guard
//  protects) and `db push` (never allowed; see README, "Local databases").
//  Not guarded: `migrate deploy` — what Railway and CI run against real
//  databases — plus generate, validate, format and read-only migrate commands.
//
//  Fails closed. It refuses unless DATABASE_URL and DIRECT_URL are set, every
//  database URL is localhost, and none is byte-identical to a value in
//  backend/.env. That holds whether Prisma loads .env before or after this
//  file runs: a missing URL is a refusal, and a loaded production URL is not
//  localhost.
//
//  Holds no credentials and needs none: it compares hostnames only, and never
//  prints a password.
// ─────────────────────────────────────────────────────────────────

import path from 'node:path'
import dotenv from 'dotenv'
import { defineConfig } from 'prisma/config'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const GUARDED: ReadonlyArray<readonly [string, string]> = [
  ['migrate', 'dev'],
  ['migrate', 'reset'],
  ['db', 'push'],
  ['db', 'seed'],
]

/** "migrate dev" etc. if argv invokes a guarded command, otherwise null. */
function guardedCommand(argv: readonly string[]): string | null {
  const words = argv.slice(2).filter((a) => !a.startsWith('-'))
  for (const [group, verb] of GUARDED) {
    if (words.some((w, i) => w === group && words[i + 1] === verb)) return `${group} ${verb}`
  }
  return null
}

/** Host, port and database only — never user, password or query string. */
function mask(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.hostname}:${u.port || '(default)'}${u.pathname}`
  } catch {
    return '(unparseable URL)'
  }
}

function refuse(command: string, reason: string): never {
  throw new Error(
    `\n[prisma.config.ts local-db guard] REFUSING "prisma ${command}".\n${reason}\n\n` +
      `Destructive Prisma commands only run against the local dev database, through\n` +
      `the db:dev:* npm scripts (which load backend/.env.dev). See README, "Local databases".\n`,
  )
}

const command = guardedCommand(process.argv)
if (command) {
  // Parsed into a throwaway object, never merged into process.env.
  const productionEnv = dotenv.config({ path: path.resolve(process.cwd(), '.env'), processEnv: {} }).parsed ?? {}

  for (const name of ['DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL']) {
    const value = process.env[name]
    if (!value) {
      if (name === 'SHADOW_DATABASE_URL') continue
      refuse(command, `${name} is not set.`)
    }
    let host = ''
    try {
      host = new URL(value).hostname.toLowerCase()
    } catch {
      refuse(command, `${name} is not a valid URL.`)
    }
    if (!LOCAL_HOSTNAMES.has(host)) {
      refuse(command, `${name} points at ${mask(value)}, which is not localhost.`)
    }
    for (const [key, prodValue] of Object.entries(productionEnv)) {
      if (prodValue && prodValue === value) {
        refuse(command, `${name} is identical to ${key} in backend/.env, the production configuration.`)
      }
    }
  }
}

export default defineConfig({
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
})
