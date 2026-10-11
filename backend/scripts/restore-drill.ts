// ─────────────────────────────────────────────────────────────────
//  restore-drill — prove a backup restores (M7.7). See docs/backups.md.
//
//    npx tsx scripts/restore-drill.ts --file <path to .dump.age> [--taken-at <ISO time>] [--keep]
//    railway run npx tsx scripts/restore-drill.ts --file <…> --allow-remote <db host>   (compare with production)
//
//  1. Asks for the age secret key at a prompt (hidden; never on the command
//     line, never written to disk), and checks only its shape.
//  2. Starts a fresh postgres:17 container whose data directory is in memory
//     (tmpfs), and refuses unless its public schema is empty.
//  3. Drops the fresh database's empty public schema (the dump creates it),
//     then decrypts with `age -d -i -` (the key on age's stdin) straight into
//     `pg_restore` inside the container: schema and data, never data-only. A
//     full restore loads rows before the post-data section (triggers, foreign
//     keys), so AuditEvent's `at` survives.
//  4. Checks the restored database: the tables it must have, the audit log's
//     triggers and limits, stray tables, per-table counts.
//  5. Compares those counts with production rows created at or before the
//     backup's time, read-only through scripts/lib/read-only-db.ts.
//  6. Removes the container, always. Deletes the downloaded file only after a
//     pass, and only if it's named like the job's backups; otherwise prints a
//     one-line reminder. --keep keeps it after a pass.
//
//  Prints counts only (terminal only). Exit 0 on a pass, 1 otherwise.
// ─────────────────────────────────────────────────────────────────

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { connectReadOnly, flag, hasFlag, makeRefuse, redact } from './lib/read-only-db'
import { auditHealth } from './lib/audit-triggers'
import { strayTables } from './lib/stray-tables'
import {
  REQUIRED_TABLES, afterDrill, createdColumnOf, judgeDrill, looksLikeAgeIdentity, takenAtFromName, type TableCounts,
} from './lib/backup-drill'

const SCRIPT = 'restore-drill'
const refuse: (message: string) => never = makeRefuse(SCRIPT)
const CONTAINER = 'ledger-restore-drill'
const PORT = 55436

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' })

/** The secret key: a hidden prompt on a terminal, or the first line of piped input. */
async function readIdentity(): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    let data = ''
    for await (const chunk of stdin) {
      data += chunk
      if (data.includes('\n')) break
    }
    return data.split(/\r?\n/)[0].trim()
  }
  process.stdout.write('age secret key (input hidden): ')
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let key = ''
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(key.trim())
        }
        if (c === '\u0003') { stdin.setRawMode(false); return reject(new Error('cancelled')) }
        if (c === '\u007f' || c === '\b') key = key.slice(0, -1)
        else key += c
      }
    }
    stdin.on('data', onData)
  })
}

function psql(sql: string): string {
  const r = run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', sql])
  if (r.status !== 0) throw new Error(`psql in the drill container failed: ${r.stderr.trim().split('\n').pop()}`)
  return r.stdout.trim()
}

async function startContainer(password: string) {
  if (run('docker', ['inspect', CONTAINER]).status === 0) refuse(`a container named ${CONTAINER} already exists; remove it first (docker rm -f ${CONTAINER}).`)
  const r = run('docker', [
    'run', '-d', '--rm', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', `127.0.0.1:${PORT}:5432`, '--tmpfs', '/var/lib/postgresql/data:rw', 'postgres:17-alpine',
  ])
  if (r.status !== 0) refuse(`could not start the drill container: ${r.stderr.trim().split('\n').pop()}`)
  for (let i = 0; i < 60; i++) {
    // Over TCP: the image's first, socket-only start during initdb doesn't count.
    if (run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']).status === 0) return
    await new Promise((res) => setTimeout(res, 1000))
  }
  throw new Error('the drill container did not become ready')
}

/** age -d into pg_restore; the plaintext only ever exists in the pipe. */
function restore(file: string, identity: string): Promise<{ ageOk: boolean; restoreOk: boolean; restoreError: string }> {
  return new Promise((resolve) => {
    const age = spawn('age', ['-d', '-i', '-', file], { stdio: ['pipe', 'pipe', 'pipe'] })
    const pgRestore = spawn('docker', [
      'exec', '-i', CONTAINER, 'pg_restore', '-U', 'postgres', '-d', 'postgres', '--no-owner', '--no-privileges', '--exit-on-error',
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    let restoreError = ''
    pgRestore.stderr.on('data', (d) => { restoreError += d })
    age.stderr.resume()
    age.stdout.pipe(pgRestore.stdin)
    age.stdin.end(`${identity}\n`)
    let ageCode: number | null = null, restoreCode: number | null = null
    const done = () => {
      if (ageCode === null || restoreCode === null) return
      resolve({ ageOk: ageCode === 0, restoreOk: restoreCode === 0, restoreError: restoreError.trim().split('\n').slice(-3).join(' | ') })
    }
    age.on('close', (c) => { ageCode = c ?? 1; done() })
    pgRestore.on('close', (c) => { restoreCode = c ?? 1; done() })
    pgRestore.stdin.on('error', () => { /* age failed first: reported by its exit code */ })
  })
}

async function main() {
  const file = flag('file') ?? refuse('pass --file <path to the downloaded .dump.age>.')
  if (!existsSync(file)) refuse('no file at that --file path.')
  const fileName = path.basename(file)
  const takenAt = takenAtFromName(fileName) ?? (flag('taken-at') ? new Date(flag('taken-at')!) : null)
  if (!takenAt || Number.isNaN(takenAt.getTime())) {
    refuse(`${fileName} isn't named like a backup the job writes, so pass --taken-at <ISO time> (when the dump was taken, e.g. 2026-10-09T19:18:00Z).`)
  }
  if (run('age', ['--version']).status !== 0) refuse('age is not on PATH (docs/backups.md says how to install it).')
  if (run('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) refuse('Docker is not running.')

  const identity = await readIdentity()
  if (!looksLikeAgeIdentity(identity)) refuse("that isn't an age secret key (AGE-SECRET-KEY-1…).")

  console.log(`\n${SCRIPT}: ${fileName}, taken ${takenAt.toISOString()}`)
  let passed = false
  const password = randomBytes(18).toString('hex')
  let restored: PrismaClient | null = null
  try {
    await startContainer(password)
    if (psql(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`) !== '0') {
      throw new Error('the drill database is not empty; refusing to restore into it')
    }
    // The dump is of the public schema, so it creates public itself. In this
    // brand-new, verified-empty database, drop the empty default one first.
    psql('DROP SCHEMA public')

    const r = await restore(file, identity)
    if (!r.ageOk) throw new Error('could not decrypt: the wrong key, or a damaged file. Nothing was restored.')
    if (!r.restoreOk) throw new Error(`pg_restore failed: ${r.restoreError}`)
    console.log('Decrypted and restored into a fresh, in-memory Postgres 17.')

    restored = new PrismaClient({ datasourceUrl: `postgresql://postgres:${password}@127.0.0.1:${PORT}/postgres` })
    const tables = (await restored.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )).map((t) => t.name)
    const restoredCount = new Map<string, number>()
    for (const t of tables) {
      const [c] = await restored.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${t}"`)
      restoredCount.set(t, c.n)
    }
    const health = tables.includes('AuditEvent') ? await auditHealth(restored) : null
    const auditHealthy = !!health && health.triggers.every((t) => t.ok) && health.missingChecks.length === 0 && health.retentionMatches
    const strayInBackup = await strayTables(restored)

    // Production, read-only.
    const prod = await connectReadOnly(SCRIPT)
    console.log(`Comparing with ${prod.database} on ${prod.host} via ${prod.envName}, read-only.`)
    const prodTables = new Set((await prod.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )).map((t) => t.name))
    const counts: TableCounts[] = []
    for (const t of [...new Set([...tables, ...prodTables])].sort()) {
      let productionNow: number | null = null, productionThen: number | null = null
      if (prodTables.has(t)) {
        const col = createdColumnOf(t)
        const [info] = await prod.prisma.$queryRawUnsafe<Array<{ type: string | null }>>(
          `SELECT max(data_type) AS type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, t, col,
        )
        // Prisma's columns are timestamp without time zone, holding UTC.
        const cutoff = info.type === 'timestamp with time zone' ? '$1::timestamptz' : `($1::timestamptz AT TIME ZONE 'UTC')`
        const [c] = await prod.prisma.$queryRawUnsafe<Array<{ now: number; then: number | null }>>(
          info.type
            ? `SELECT count(*)::int AS now, count(*) FILTER (WHERE "${col}" <= ${cutoff})::int AS then FROM "${t}"`
            : `SELECT count(*)::int AS now, NULL::int AS then FROM "${t}"`,
          takenAt.toISOString(),
        )
        productionNow = c.now
        productionThen = c.then
      }
      counts.push({ table: t, restored: restoredCount.get(t) ?? null, productionThen, productionNow })
    }
    const [hd] = prodTables.has('AuditEvent')
      ? await prod.prisma.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM "AuditEvent" WHERE at > ($1::timestamptz AT TIME ZONE 'UTC')
             AND ((event = 'item.unlinked' AND outcome = 'ok') OR event = 'deletion.completed')`, takenAt.toISOString())
      : [{ n: 0 }]
    await prod.prisma.$disconnect()

    console.log(`\n${'table'.padEnd(20)} ${'backup'.padStart(8)} ${'prod then'.padStart(10)} ${'prod now'.padStart(9)}`)
    const show = (n: number | null) => (n === null ? '-' : String(n))
    for (const c of counts) console.log(`${c.table.padEnd(20)} ${show(c.restored).padStart(8)} ${show(c.productionThen).padStart(10)} ${show(c.productionNow).padStart(9)}`)
    console.log(`\nAudit log in the backup: ${auditHealthy ? 'triggers and limits all in place' : 'NOT all in place'}. Required tables: ${REQUIRED_TABLES.join(', ')}.`)
    console.log(`Unlinks and account deletions in production since the backup: ${hd.n}.`)

    const verdict = judgeDrill(counts, { hardDeletesSince: hd.n, strayInBackup, auditHealthy })
    for (const w of verdict.warnings) console.log(`  note: ${w}`)
    for (const f of verdict.failures) console.log(`  FAIL: ${f}`)
    passed = verdict.failures.length === 0
    console.log(passed ? '\nPASS: the backup restores, and nothing production had by then is missing.' : '\nFAILED.')
  } catch (e: any) {
    console.error(`\n✗ ${SCRIPT}: ${redact(String(e?.message ?? e))}`)
  } finally {
    if (restored) await restored.$disconnect().catch(() => {})
    run('docker', ['rm', '-f', CONTAINER])
    const after = afterDrill({ passed, fileName, keep: hasFlag('keep') })
    if (after.action === 'delete') unlinkSync(path.resolve(file))
    console.log(after.message)
  }
  process.exitCode = passed ? 0 : 1
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  run('docker', ['rm', '-f', CONTAINER])
  process.exit(1)
})
