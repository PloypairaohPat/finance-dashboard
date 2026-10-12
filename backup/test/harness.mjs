#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  backup harness — the backup job and the restore drill, end to end, against
//  throwaway containers (M7.7). Run it by hand from the repo root:
//
//    node backup/test/harness.mjs
//
//  Needs Docker, the local dev database container (findash-dev-pg, which
//  seeds the test database with the dev data and every migration), and age on
//  PATH for the drill. Nothing here touches production, R2 or Sentry:
//    - Postgres 17, seeded from the dev database, with backup_reader set up
//      exactly as docs/backups.md tells you to in production, and a
//      partial_reader that can't read "Transaction" (a dump that dies part-way);
//    - rclone's S3 server (rclone serve s3, from the job's own image) standing in for R2;
//    - a fake Sentry that logs each check-in it receives.
//  Every secret is generated per run, and every output is checked for them.
// ─────────────────────────────────────────────────────────────────

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND = path.join(ROOT, 'backend')
const NET = 'ledger-bk-test', PG = 'ledger-bk-pg', MINIO = 'ledger-bk-minio', SENTRY = 'ledger-bk-sentry', TARGET = 'ledger-bk-target'
const IMAGE = 'ledger-backup:harness', BUCKET = 'ledger-bk-test', PG_PORT = 55438
const hex = (n) => randomBytes(n).toString('hex')
const S = { pg: hex(12), reader: hex(12), partial: hex(12), target: hex(12), minioUser: `u${hex(6)}`, minioPass: hex(16), sentryKey: hex(16) }
const DRILL_DIR = path.join(os.tmpdir(), `ledger-bk-drill-${hex(3)}`)

// Every step has a timeout: a hang fails loudly instead of waiting forever.
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, ...opts })
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`); return r }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const outputs = []
function check(ok, what) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

function cleanup() {
  docker(['rm', '-f', PG, MINIO, SENTRY, TARGET, 'ledger-restore-drill'])
  docker(['network', 'rm', NET])
  rmSync(DRILL_DIR, { recursive: true, force: true })
}

function devDb() {
  const env = readFileSync(path.join(BACKEND, '.env.dev'), 'utf8')
  const url = new URL(/^DATABASE_URL=(.*)$/m.exec(env)[1].trim().replace(/^["']|["']$/g, ''))
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('backend/.env.dev does not point at a local database')
  return { user: decodeURIComponent(url.username), db: url.pathname.slice(1) }
}

/** Pipe one process's stdout into another's stdin, binary-safe; resolves to both exit codes. */
function pipe(fromArgs, toArgs) {
  return new Promise((resolve) => {
    const a = spawn('docker', fromArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const b = spawn('docker', toArgs, { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    a.stderr.on('data', (d) => { err += d }); b.stderr.on('data', (d) => { err += d })
    a.stdout.pipe(b.stdin)
    let ca = null, cb = null
    const done = () => { if (ca !== null && cb !== null) resolve({ ok: ca === 0 && cb === 0, err }) }
    a.on('close', (c) => { ca = c; done() }); b.on('close', (c) => { cb = c; done() })
  })
}

const psql = (sql) => must(docker(['exec', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]), `psql: ${sql.slice(0, 40)}`)

function jobEnv(over = {}) {
  const env = {
    BACKUP_DATABASE_URL: `postgresql://backup_reader:${S.reader}@${PG}:5432/postgres`,
    BACKUP_AGE_RECIPIENT: S.agePublic,
    R2_ACCOUNT_ID: '0'.repeat(32),
    R2_ACCESS_KEY_ID: S.minioUser,
    R2_SECRET_ACCESS_KEY: S.minioPass,
    R2_BUCKET: BUCKET,
    R2_ENDPOINT: `http://${MINIO}:9000`,
    SENTRY_DSN: `http://${S.sentryKey}@${SENTRY}:9000/1`,
    ...over,
  }
  return Object.entries(env).filter(([, v]) => v !== undefined).flatMap(([k, v]) => ['-e', `${k}=${v}`])
}

function runJob(over = {}) {
  const r = docker(['run', '--rm', '--network', NET, ...jobEnv(over), IMAGE])
  const out = `${r.stdout}${r.stderr}`
  outputs.push(out)
  return { code: r.status, out }
}

/** rclone, in the job's own image, against MinIO. */
function rclone(args) {
  return docker(['run', '--rm', '--network', NET, '--entrypoint', 'rclone', ...jobEnv(), '-e', 'RCLONE_CONFIG_R2_TYPE=s3', '-e', 'RCLONE_CONFIG_R2_PROVIDER=Minio',
    '-e', `RCLONE_CONFIG_R2_ACCESS_KEY_ID=${S.minioUser}`, '-e', `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${S.minioPass}`, '-e', `RCLONE_CONFIG_R2_ENDPOINT=http://${MINIO}:9000`,
    IMAGE, ...args])
}
const list = (prefix) => rclone(['lsf', `r2:${BUCKET}/${prefix}/`]).stdout.split('\n').filter(Boolean)

/** Check-ins the fake Sentry has received since `from` (a line count). */
function checkins(from) {
  const lines = docker(['logs', SENTRY]).stdout.split('\n').filter((l) => l.startsWith('CHECKIN '))
  return { all: lines.length, since: lines.slice(from).map((l) => Object.fromEntries(new URL(l.slice(8), 'http://x').searchParams)) }
}

async function main() {
  cleanup()
  const dev = devDb()
  console.log('Building the image and starting throwaway containers…')
  must(docker(['build', '-q', '-f', 'backup/Dockerfile', '-t', IMAGE, '.'], { cwd: ROOT }), 'docker build')
  must(docker(['network', 'create', NET]), 'network')
  must(docker(['run', '-d', '--name', PG, '--network', NET, '-e', `POSTGRES_PASSWORD=${S.pg}`, '-p', `127.0.0.1:${PG_PORT}:5432`, 'postgres:17-alpine']), 'postgres')
  // rclone's own S3 server, from the job's image, stands in for R2.
  must(docker(['run', '-d', '--name', MINIO, '--network', NET, '--entrypoint', 'rclone', IMAGE, 'serve', 's3', '--auth-key', `${S.minioUser},${S.minioPass}`, '--addr', ':9000', '/tmp/s3']), 'the S3 stand-in')
  const server = "require('http').createServer((q,s)=>{console.log('CHECKIN '+q.url);s.end('ok')}).listen(9000)"
  must(docker(['run', '-d', '--name', SENTRY, '--network', NET, 'node:22-alpine', 'node', '-e', server]), 'fake sentry')
  for (let i = 0; i < 60 && docker(['exec', PG, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']).status !== 0; i++) await sleep(1000)

  console.log('Seeding it from the dev database (schema and data, a fresh restore)…')
  psql('DROP SCHEMA public') // the dump creates it, as in the drill
  const seed = await pipe(
    ['exec', 'findash-dev-pg', 'pg_dump', '-U', dev.user, '-d', dev.db, '--format=custom', '--schema=public', '--no-owner', '--no-privileges'],
    ['exec', '-i', PG, 'pg_restore', '-U', 'postgres', '-d', 'postgres', '--no-owner', '--no-privileges', '--exit-on-error'],
  )
  if (!seed.ok) throw new Error(`seeding failed: ${seed.err.trim().split('\n').slice(-3).join(' | ')}`)

  // The production role, exactly as docs/backups.md has it; the password is set separately there (\password).
  psql('CREATE ROLE backup_reader LOGIN BYPASSRLS')
  psql('GRANT pg_read_all_data TO backup_reader')
  psql('ALTER ROLE backup_reader SET default_transaction_read_only = on')
  psql(`ALTER ROLE backup_reader PASSWORD '${S.reader}'`)
  psql(`CREATE ROLE partial_reader LOGIN PASSWORD '${S.partial}'`)
  psql('GRANT pg_read_all_data TO partial_reader')
  psql('CREATE ROLE no_transactions')
  // pg_read_all_data can't be partly revoked, so this role reads table by table instead.
  psql('REVOKE pg_read_all_data FROM partial_reader')
  psql('GRANT USAGE ON SCHEMA public TO partial_reader')
  psql('GRANT SELECT ON ALL TABLES IN SCHEMA public TO partial_reader')
  psql('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO partial_reader')
  psql('REVOKE SELECT ON "Transaction" FROM partial_reader')
  const rows = psql('SELECT count(*) FROM "Transaction"').stdout.trim()

  const keys = must(docker(['run', '--rm', '--entrypoint', 'age-keygen', IMAGE]), 'age-keygen').stdout
  S.agePublic = /public key: (age1[0-9a-z]+)/.exec(keys)[1]
  S.ageSecret = /(AGE-SECRET-KEY-1[0-9A-Z]+)/.exec(keys)[1]
  const wrongSecret = /(AGE-SECRET-KEY-1[0-9A-Z]+)/.exec(must(docker(['run', '--rm', '--entrypoint', 'age-keygen', IMAGE]), 'age-keygen').stdout)[1]
  console.log('Creating the bucket in the S3 stand-in…')
  for (let i = 0; i < 30 && rclone(['mkdir', `r2:${BUCKET}`]).status !== 0; i++) await sleep(1000)

  console.log(`\nThe job (seeded with ${rows} transactions):`)
  let c = checkins(0).all
  const ok = runJob()
  const daily = list('daily')
  let ci = checkins(c)
  check(ok.code === 0, 'a good run exits 0')
  check(daily.length === 1 && /^ledger-\d{4}-\d{2}-\d{2}T\d{6}Z\.dump\.age$/.test(daily[0]), `it lands in daily/ under the job's name (${daily[0] ?? 'nothing'})`)
  check(list('incoming').length === 0, 'and leaves nothing in incoming/')
  check(ci.since.map((x) => x.status).join(',') === 'in_progress,ok' && ci.since[0].check_in_id === ci.since[1]?.check_in_id, 'Sentry: in_progress then ok, one check_in_id')

  const scenarios = [
    ['a missing variable', { R2_BUCKET: undefined }, /missing required variables: R2_BUCKET/],
    ['the transaction pooler port', { BACKUP_DATABASE_URL: `postgresql://backup_reader:${S.reader}@${PG}:6543/postgres` }, /port 5432/],
    ['a malformed recipient', { BACKUP_AGE_RECIPIENT: 'age1notakey' }, /BACKUP_AGE_RECIPIENT is not/],
    // pg_dump locks every table first, so this one fails before any data streams.
    ['a role that can\'t read a table', { BACKUP_DATABASE_URL: `postgresql://partial_reader:${S.partial}@${PG}:5432/postgres` }, /did not finish/],
    ['a wrong database password', { BACKUP_DATABASE_URL: `postgresql://backup_reader:wrong${S.reader}@${PG}:5432/postgres` }, /did not finish/],
  ]
  for (const [what, over, message] of scenarios) {
    c = checkins(0).all
    const r = runJob(over)
    ci = checkins(c)
    console.log(`\n${what}:`)
    check(r.code === 1, 'exits 1')
    check(message.test(r.out), `says why (${message.source})`)
    check(list('daily').length === 1 && list('incoming').length === 0, 'adds nothing to daily/, and leaves nothing in incoming/')
    check(ci.since.at(-1)?.status === 'error', 'Sentry: an error check-in')
  }
  // A dump cut off mid-stream: by then the encrypted object is well past the size
  // floor, so only pipefail and promote-on-success stand between it and daily/.
  console.log('\na dump cut off mid-stream:')
  psql('CREATE TABLE "HarnessPadding" AS SELECT i, md5(i::text) || md5((i * 7)::text) AS pad FROM generate_series(1, 2000000) i')
  c = checkins(0).all
  const midStream = await new Promise((resolve) => {
    const job = spawn('docker', ['run', '--rm', '--network', NET, ...jobEnv(), IMAGE], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    job.stdout.on('data', (d) => { out += d }); job.stderr.on('data', (d) => { out += d })
    let killed = false
    const poll = setInterval(() => {
      if (killed) return
      const pid = docker(['exec', PG, 'psql', '-U', 'postgres', '-tAc',
        `SELECT pid FROM pg_stat_activity WHERE usename = 'backup_reader' AND query LIKE 'COPY public."HarnessPadding"%'`]).stdout.trim()
      if (pid) { killed = true; docker(['exec', PG, 'psql', '-U', 'postgres', '-tAc', `SELECT pg_terminate_backend(${pid})`]) }
    }, 50)
    job.on('close', (code) => { clearInterval(poll); outputs.push(out); resolve({ code, out, killed }) })
  })
  ci = checkins(c)
  psql('DROP TABLE "HarnessPadding"')
  check(midStream.killed, "the dump's session was terminated while it streamed")
  check(midStream.code === 1 && /did not finish/.test(midStream.out), 'exits 1: the dump, its encryption or its upload did not finish')
  check(list('daily').length === 1 && list('incoming').length === 0, 'adds nothing to daily/, and leaves nothing in incoming/')
  check(ci.since.at(-1)?.status === 'error', 'Sentry: an error check-in')

  console.log('\nno SENTRY_DSN at all:')
  c = checkins(0).all
  const noDsn = runJob({ SENTRY_DSN: undefined })
  check(noDsn.code === 1 && /missing required variables: SENTRY_DSN/.test(noDsn.out), 'exits 1, naming SENTRY_DSN')
  check(checkins(c).since.length === 0, "sends nothing (Sentry's missed check-in alert is what fires)")

  console.log('\nNo secret in any output:')
  const leaked = Object.entries({ ...S, agePublic: undefined }).filter(([, v]) => v && outputs.some((o) => o.includes(v))).map(([k]) => k)
  check(leaked.length === 0, leaked.length ? `leaked: ${leaked.join(', ')}` : 'database passwords, R2 secret, Sentry key, age key')

  // ── The drill ──
  console.log('\nThe restore drill, against the backup the job just wrote:')
  mkdirSync(DRILL_DIR, { recursive: true })
  const download = (as) => new Promise((resolve, reject) => {
    const target = path.join(DRILL_DIR, as)
    const p = spawn('docker', ['run', '--rm', '--network', NET, '--entrypoint', 'rclone', '-e', 'RCLONE_CONFIG_R2_TYPE=s3', '-e', 'RCLONE_CONFIG_R2_PROVIDER=Minio',
      '-e', `RCLONE_CONFIG_R2_ACCESS_KEY_ID=${S.minioUser}`, '-e', `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${S.minioPass}`, '-e', `RCLONE_CONFIG_R2_ENDPOINT=http://${MINIO}:9000`,
      IMAGE, 'cat', `r2:${BUCKET}/daily/${daily[0]}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    p.stdout.pipe(createWriteStream(target))
    p.on('close', (code) => (code === 0 ? resolve(target) : reject(new Error('download failed'))))
  })
  const drill = (file, key, extra = []) => {
    const url = `postgresql://postgres:${S.pg}@127.0.0.1:${PG_PORT}/postgres`
    const args = ['tsx', 'scripts/restore-drill.ts', '--file', file, ...extra]
    // Windows runs npx through a shell: one command string, each argument quoted.
    const [cmd, argv] = process.platform === 'win32' ? [['npx', ...args.map((a) => `"${a}"`)].join(' '), []] : ['npx', args]
    const r = spawnSync(cmd, argv, {
      cwd: BACKEND, input: `${key}\n`, encoding: 'utf8', shell: process.platform === 'win32', timeout: 300_000,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, ...readDevKeys() },
    })
    const out = `${r.stdout}${r.stderr}`
    outputs.push(out)
    return { code: r.status, out }
  }

  // ── backup/restore.sh: a real restore's path, into a fresh database ──
  console.log('\nbackup/restore.sh, into a fresh, empty database:')
  must(docker(['run', '-d', '--name', TARGET, '--network', NET, '-e', `POSTGRES_PASSWORD=${S.target}`, 'postgres:17-alpine']), 'restore target')
  for (let i = 0; i < 60 && docker(['exec', TARGET, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']).status !== 0; i++) await sleep(1000)
  const target = (sql) => docker(['exec', TARGET, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', sql]).stdout.trim()
  const restoreSh = (file, key) => {
    const r = docker(['run', '--rm', '-i', '--network', NET, '-e', `RESTORE_TARGET_URL=postgresql://postgres:${S.target}@${TARGET}:5432/postgres`,
      '--tmpfs', '/work', '-v', `${DRILL_DIR}:/in:ro`, '-v', `${path.join(ROOT, 'backup')}:/b:ro`, 'postgres:17-alpine',
      'sh', '/b/restore.sh', `/in/${path.basename(file)}`], { input: `${key}\n` })
    const out = `${r.stdout}${r.stderr}`
    outputs.push(out)
    return { code: r.status, out }
  }
  const tablesIn = (sqlRun) => sqlRun(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`)
  console.log('  (downloading the backup)')
  let f = await download(daily[0])
  let rs = restoreSh(f, wrongSecret)
  check(rs.code === 1 && /could not decrypt/.test(rs.out) && tablesIn(target) === '0', 'a wrong key: refuses, and the target stays empty')
  rs = restoreSh(f, S.ageSecret)
  const sourceTables = tablesIn((sql) => psql(sql).stdout.trim())
  check(rs.code === 0 && tablesIn(target) === sourceTables, `the right key: every table restored (${tablesIn(target)} of ${sourceTables})`)
  check(target('SELECT count(*) FROM "Transaction"') === rows && target('SELECT count(*) FROM "AuditEvent"') === psql('SELECT count(*) FROM "AuditEvent"').stdout.trim(), 'with every row (Transaction, AuditEvent)')
  check(target(`SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AuditEvent"'::regclass AND NOT tgisinternal`) === '4', "and the audit log's four triggers")
  rs = restoreSh(f, S.ageSecret)
  check(rs.code === 1 && /Restore only into an empty database/.test(rs.out), 'a second restore into the same database is refused')
  rmSync(f, { force: true })

  console.log('\nThe drill:')
  f = await download(daily[0])
  let d = drill(f, S.ageSecret)
  check(d.code === 0 && /PASS/.test(d.out), 'the right key: restores, and every count matches the source')
  check(!existsSync(f) && /Deleted ledger-/.test(d.out), 'after a pass, the downloaded file is deleted')

  f = await download(daily[0])
  d = drill(f, wrongSecret)
  check(d.code === 1 && /could not decrypt/.test(d.out), 'a wrong key: fails to decrypt, and nothing is restored')
  check(existsSync(f) && /still there/.test(d.out), 'after a failure, the file is kept, with a reminder')

  d = drill(f, S.ageSecret, ['--keep'])
  check(d.code === 0 && existsSync(f), '--keep: kept after a pass')

  const hand = path.join(DRILL_DIR, 'ledger-2026-10-09.dump.age')
  renameSync(f, hand)
  d = drill(hand, S.ageSecret, ['--taken-at', new Date().toISOString()])
  check(d.code === 0 && existsSync(hand) && /never deletes it/.test(d.out), 'a hand-made name (like the Oct 9 dump): passes, never deleted')
  check(docker(['inspect', 'ledger-restore-drill']).status !== 0, 'the drill container is gone')

  const leaked2 = [S.ageSecret, wrongSecret, S.pg, S.target].filter((v) => outputs.some((o) => o.includes(v)))
  check(leaked2.length === 0, 'neither the drill nor restore.sh prints a key or a database password')
}

/** The drill imports app modules that read the local dev Clerk keys; nothing is sent anywhere. */
function readDevKeys() {
  const env = readFileSync(path.join(BACKEND, '.env.dev'), 'utf8')
  const out = {}
  for (const k of ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'ENCRYPTION_KEY', 'AUDIT_HASH_KEY']) {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(env)
    if (m) out[k] = m[1].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

main()
  .catch((e) => { console.error(`\nharness error: ${e.message}`); failures++ })
  .finally(() => {
    cleanup()
    console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.')
    process.exitCode = failures ? 1 : 0
  })
