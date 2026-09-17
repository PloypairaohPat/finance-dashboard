// ─────────────────────────────────────────────────────────────────
//  backfill-clean — normalise merchant names and resolve pending
//  duplicates for one user. It WRITES.
//
//  It used to call dotenv.config() and default to DEFAULT_USER_ID, so a bare
//  run wrote to whatever backend/.env pointed at (production, at the time).
//  Now nothing is implicit:
//    - the database is DATABASE_URL from the caller's environment. This file
//      loads no .env, but the generated Prisma client does: importing it reads
//      backend/.env for anything not already set. So the host check below, not
//      the absence of dotenv, is what stops a bare run from writing somewhere
//      real (and backend/.env's DATABASE_URL is a .invalid placeholder anyway);
//    - the user is a required --user flag;
//    - a non-local host is refused unless --allow-remote names that exact host.
//      The flag takes a hostname, never a URL, so no credential goes on the
//      command line.
//
//  Local:
//    npm run db:guard && npx dotenv -e .env.dev -- tsx src/scripts/backfill-clean.ts --user demo-user
//  Production, deliberately (Railway injects DATABASE_URL):
//    railway run npx tsx src/scripts/backfill-clean.ts --user <id> --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

import { PrismaClient }      from '@prisma/client'
import { cleanTransactions } from '../services/cleaner'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function flag(name: string): string | undefined {
  const args = process.argv.slice(2)
  const i = args.indexOf(`--${name}`)
  if (i >= 0) return args[i + 1]
  const inline = args.find(a => a.startsWith(`--${name}=`))
  return inline?.slice(name.length + 3)
}

function refuse(message: string): never {
  console.error(`✗ backfill-clean refused: ${message}`)
  process.exit(1)
}

function resolveTarget(
  databaseUrl: string | undefined,
  user: string | undefined,
  allowRemote: string | undefined,
): { host: string; user: string } {
  if (!databaseUrl) refuse('DATABASE_URL is not set. Supply the environment explicitly, e.g. npx dotenv -e .env.dev -- ...')
  if (!user || user.startsWith('--')) refuse('--user <id> is required. There is no default user.')

  let host: string
  try {
    host = new URL(databaseUrl).hostname.toLowerCase()
  } catch {
    refuse('DATABASE_URL is not a valid URL.')
  }

  if (!LOCAL_HOSTNAMES.has(host) && allowRemote?.toLowerCase() !== host) {
    refuse(
      `DATABASE_URL points at "${host}", which is not local. ` +
      `To write there on purpose, pass --allow-remote ${host}.`,
    )
  }
  return { host, user }
}

async function main() {
  const { host, user } = resolveTarget(process.env.DATABASE_URL, flag('user'), flag('allow-remote'))
  console.log(`🧹 Running backfill clean for user "${user}" on ${host}...\n`)

  const prisma = new PrismaClient()
  try {
    const result = await cleanTransactions(prisma, user)
    console.log(`✓ normalized ${result.normalized} merchant names`)
    console.log(`✓ resolved   ${result.resolved} pending duplicates`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
