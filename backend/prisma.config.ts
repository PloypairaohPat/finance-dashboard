// ─────────────────────────────────────────────────────────────────
//  prisma.config.ts — refuse Prisma commands that can write to a database,
//  against anything but a local one, however they are invoked.
//
//  M7.0 wired scripts/guard-local-db.ts as a `pre` npm script, so the
//  db:dev:* scripts can't reach production. It could not catch a bare
//  `npx prisma migrate dev`: that path never runs the npm pre-script and read
//  backend/.env, which holds the production DATABASE_URL. The Prisma CLI
//  evaluates this file on every command, so the check here applies no matter
//  how Prisma is started. (With a config file present, Prisma 6.x also stops
//  loading .env on its own — see README, "Local databases".)
//
//  Guarded — every CLI command that can write to a database. Over-broad is the
//  intended failure mode:
//    migrate dev · migrate reset · migrate resolve · db push · db execute ·
//    db seed · studio
//
//  NOT guarded:
//    migrate deploy — how deployments apply migrations to the real database.
//      Refusing it would stop production migrations from being applied, so it
//      is left open pending an explicit decision; see docs/overnight-questions.md.
//    generate, validate, format, version, migrate status / diff, db pull —
//      none of these write to a database (db pull writes the local schema file).
//
//  Fails closed. A guarded command is refused unless DATABASE_URL and
//  DIRECT_URL are set, every database URL — including a `--url` flag, which
//  `db execute` reads instead of the environment — is localhost, and none is
//  byte-identical to a value in backend/.env.
//
//  Holds no credentials and needs none: it compares hostnames only and never
//  prints a password.
// ─────────────────────────────────────────────────────────────────

import path from 'node:path'
import dotenv from 'dotenv'
import { defineConfig } from 'prisma/config'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const GUARDED: ReadonlyArray<readonly string[]> = [
  ['migrate', 'dev'],
  ['migrate', 'reset'],
  ['migrate', 'resolve'],
  ['db', 'push'],
  ['db', 'execute'],
  ['db', 'seed'],
  ['studio'],
]

/** "migrate dev" etc. if argv invokes a guarded command, otherwise null. */
function guardedCommand(argv: readonly string[]): string | null {
  const words = argv.slice(2).filter((a) => !a.startsWith('-'))
  for (const cmd of GUARDED) {
    if (words.some((_, i) => cmd.every((w, j) => words[i + j] === w))) return cmd.join(' ')
  }
  return null
}

/** Every `--url <value>` / `--url=<value>` passed on the command line. */
function urlFlags(argv: readonly string[]): string[] {
  const out: string[] = []
  argv.forEach((arg, i) => {
    if (arg === '--url' && argv[i + 1]) out.push(argv[i + 1])
    else if (arg.startsWith('--url=')) out.push(arg.slice('--url='.length))
  })
  return out
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
      `Prisma commands that can write to a database only run against the local dev\n` +
      `database, through the db:dev:* npm scripts (which load backend/.env.dev).\n` +
      `See README, "Local databases".\n`,
  )
}

function assertLocal(command: string, label: string, value: string, productionEnv: Record<string, string>): void {
  let host = ''
  try {
    host = new URL(value).hostname.toLowerCase()
  } catch {
    refuse(command, `${label} is not a valid URL.`)
  }
  if (!LOCAL_HOSTNAMES.has(host)) {
    refuse(command, `${label} points at ${mask(value)}, which is not localhost.`)
  }
  for (const [key, prodValue] of Object.entries(productionEnv)) {
    if (prodValue && prodValue === value) {
      refuse(command, `${label} is identical to ${key} in backend/.env, the production configuration.`)
    }
  }
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
    assertLocal(command, name, value, productionEnv)
  }
  for (const value of urlFlags(process.argv)) {
    assertLocal(command, '--url', value, productionEnv)
  }
}

export default defineConfig({
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
})
