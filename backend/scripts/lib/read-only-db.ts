// ─────────────────────────────────────────────────────────────────
//  read-only-db — connect to a database in a way that cannot write.
//
//  For scripts that are safe to point at production: audit-plaid-webhooks.ts
//  and update-item-webhook.ts. Written from payment-app-income-report.ts's
//  version, which still has its own copy — moving it onto this module is a
//  follow-up, done when there is a database to run it against afterwards.
//  The argument for why this is safe should live in one place.
//
//  Read-only is asked for TWICE, because either way can be unavailable:
//    1. `options=-c default_transaction_read_only=on` on the URL. A startup
//       parameter, and a pooler need not forward it — Supabase's Supavisor
//       doesn't, in session mode or transaction mode.
//    2. `SET SESSION` after connecting. An ordinary statement, so a pooler
//       passes it through. It sticks on a session-mode connection; in
//       transaction mode it is discarded and the check below catches that.
//
//  Neither is trusted. What decides is a write that must fail.
// ─────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** `--name value` or `--name=value`. */
export function flag(name: string): string | undefined {
  const args = process.argv.slice(2)
  const i = args.indexOf(`--${name}`)
  if (i >= 0) return args[i + 1]
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
}

export function makeRefuse(scriptName: string) {
  return (message: string): never => {
    console.error(`✗ ${scriptName} refused: ${message}`)
    process.exit(1)
  }
}

export interface ReadOnlyConnection {
  prisma: PrismaClient
  /** Which environment variable the URL came from. */
  envName: string
  host: string
  port: string
  database: string
  serverVersion: string
  setSessionError: string | null
  /** Postgres's own words for why the test write failed. */
  writeRefusedWith: string
}

export interface ResolvedConnection {
  /** Which environment variable the URL came from. */
  envName: string
  /** The connection URL, unmodified. Never print it: it carries the password. */
  url: URL
  host: string
  isLocal: boolean
}

/**
 * Pick the connection and apply the --allow-remote speed bump, or exit.
 *
 * DIRECT_URL first, then DATABASE_URL, overridable with `--url-env NAME`; every
 * refusal names the variable it read.
 *
 * `--allow-remote <host>` is compared with the host ACTUALLY in the chosen
 * connection string, in both directions:
 *   - a remote host needs --allow-remote naming exactly that host;
 *   - --allow-remote naming a host the connection does not point at is refused
 *     too, even when the connection is local. Either mismatch means the person
 *     running it believes they are pointed somewhere they are not.
 * A speed bump, not a security boundary: it makes pointing at production a
 * deliberate, named act. Nothing here reads RAILWAY_ENVIRONMENT or any other
 * variable a laptop can set to look like a server.
 *
 * Used by connectReadOnly and by the demo seed's write mode, so read and write
 * agree on which database they mean.
 */
export function resolveConnection(scriptName: string): ResolvedConnection {
  // Typed explicitly: TypeScript only narrows after a never-returning call when
  // the callee's type is declared, not inferred.
  const refuse: (message: string) => never = makeRefuse(scriptName)

  const asked = flag('url-env')
  let envName: string
  let raw: string
  if (asked) {
    const value = process.env[asked]
    if (!value) refuse(`--url-env ${asked} was given, but ${asked} is not set in this environment.`)
    envName = asked
    raw = value
  } else if (process.env.DIRECT_URL) {
    envName = 'DIRECT_URL'
    raw = process.env.DIRECT_URL
  } else if (process.env.DATABASE_URL) {
    envName = 'DATABASE_URL'
    raw = process.env.DATABASE_URL
  } else {
    refuse('neither DIRECT_URL nor DATABASE_URL is set. Supply the environment explicitly, or pass --url-env NAME.')
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    refuse(`${envName} is not a valid URL.`)
  }
  const host = parsed.hostname.toLowerCase()
  const isLocal = LOCAL_HOSTNAMES.has(host)
  const allowRemote = flag('allow-remote')?.toLowerCase()
  if (allowRemote !== undefined && allowRemote !== host) {
    refuse(
      `--allow-remote names "${allowRemote}", but ${envName} points at "${host}".\n` +
      '  They must match exactly: this refuses rather than guess which one you meant.',
    )
  }
  if (!isLocal && allowRemote !== host) {
    refuse(
      `${envName} points at "${host}", which is not local. To use it, pass --allow-remote ${host}.` +
      (envName === 'DIRECT_URL' ? '\n  (Reading DIRECT_URL, not DATABASE_URL — the host to name is this one.)' : ''),
    )
  }
  return { envName, url: parsed, host, isLocal }
}

/**
 * Connect read-only, or exit. See resolveConnection for which database, and
 * the header of this file for why the session cannot write.
 */
export async function connectReadOnly(scriptName: string): Promise<ReadOnlyConnection> {
  const refuse: (message: string) => never = makeRefuse(scriptName)
  const { envName, url, host } = resolveConnection(scriptName)
  const parsed = new URL(url.toString())

  parsed.searchParams.set('options', '-c default_transaction_read_only=on')
  // One connection, so what is verified below is what every later query uses.
  parsed.searchParams.set('connection_limit', '1')
  // The shared Prisma client reads DATABASE_URL, whichever variable this came from.
  process.env.DATABASE_URL = parsed.toString()

  const { default: prisma } = await import('../../src/lib/prisma')
  const ask = async (sql: string): Promise<string> => {
    const [row] = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(sql)
    return Object.values(row)[0]
  }

  let setSessionError: string | null = null
  try {
    await prisma.$executeRawUnsafe('SET SESSION default_transaction_read_only = on')
  } catch (e: any) {
    setSessionError = e.code ?? e.message
  }

  let serverVersion: string
  try {
    serverVersion = await ask('SELECT version()')
  } catch (e: any) {
    refuse(
      `could not connect using ${envName} (${host}): ${e.code ?? e.message}
  If that host is unreachable from here, try the other connection:
  --url-env DATABASE_URL --allow-remote <that host>.`,
    )
  }

  // The test that decides. A boolean, not the error text: Prisma formats errors
  // with a leading blank line, so reading "did it fail?" off the first line
  // reported a refused write as accepted.
  let writesRefused = false
  let writeRefusedWith = ''
  try {
    await prisma.$executeRawUnsafe('UPDATE "User" SET "periodStartDay" = "periodStartDay" WHERE false')
  } catch (e: any) {
    writesRefused = true
    const lines = String(e?.message ?? e).split('\n').map((l: string) => l.trim()).filter(Boolean)
    writeRefusedWith = lines.find((l: string) => /read-only|cannot execute/i.test(l)) ?? lines[0] ?? 'refused'
  }
  if (!writesRefused) {
    refuse(
      `writes are still accepted on ${envName} (${host}), so this is not a read-only session.
  SET SESSION was ${setSessionError ? `refused (${setSessionError})` : 'accepted'}.
  A pooler in TRANSACTION mode discards SET SESSION, which does this. Use a session
  connection (Supabase: the Session pooler, or the direct host), put it in its own
  variable, and pass --url-env NAME --allow-remote <that host>.`,
    )
  }

  return {
    prisma,
    envName,
    host,
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, ''),
    serverVersion,
    setSessionError,
    writeRefusedWith,
  }
}

/**
 * Scrub anything token-shaped before printing.
 *
 * Plaid's tokens are `access-production-<uuid>` / `access-sandbox-<uuid>`, and
 * its errors quote the request back. Applied to every string this family of
 * scripts prints, so a token cannot reach a terminal, a log or a paste.
 */
export function redact(text: string): string {
  return text
    .replace(/access-(production|sandbox|development)-[0-9a-zA-Z-]+/g, 'access-<redacted>')
    .replace(/\b(public|link)-(production|sandbox|development)-[0-9a-zA-Z-]+/g, '$1-<redacted>')
    .replace(/[0-9a-f]{64}/gi, '<redacted-64-hex>')
}
