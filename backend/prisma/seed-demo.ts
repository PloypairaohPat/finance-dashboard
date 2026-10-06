/**
 * seed-demo.ts — rebuild the demo user's data from prisma/demo-dataset.ts.
 *
 * The data lives in demo-dataset.ts as a pure function, with the manifest of
 * what the classifier must decide about every row. This file is the writer.
 *
 * It deletes and rebuilds rows in a database that may also hold real users,
 * so it is built like a migration:
 *
 *   - ONE TRANSACTION. The wipe and the rebuild commit together or not at all.
 *     If anything fails partway, the demo keeps its old data, and visitors to
 *     ?demo=1 never see a half-built or empty demo — readers keep seeing the
 *     old rows until the commit.
 *
 *   - EVERYONE ELSE IS PROVEN UNTOUCHED, before commit. Every non-demo row is
 *     fingerprinted (count and id hash, per table and per user) inside the
 *     transaction before the first write, and again after the last. Any
 *     difference throws, which rolls the whole rebuild back. (A check after
 *     commit would only report damage already done.) The transaction is
 *     REPEATABLE READ, so both fingerprints see the same snapshot and a real
 *     user syncing mid-run cannot look like damage; only this transaction's
 *     own writes could change the second one.
 *
 *   - --dry-run goes through scripts/lib/read-only-db.ts: the database itself
 *     refuses writes, so a wrong code path cannot write either.
 *
 *   - --allow-remote <host> is required for any non-local database and must
 *     name the host actually in the connection string (scripts/lib/
 *     read-only-db.ts: resolveConnection). Nothing is keyed on an environment
 *     variable, and guard-local-db.ts is untouched: `npm run db:dev:seed` still
 *     runs it first.
 *
 * Every delete is `where: { userId: DEMO_USER_ID }`, where DEMO_USER_ID is the
 * literal 'demo-user' (an undefined here would mean NO filter). One foreign key
 * cascades: SubscriptionMark -> Transaction is ON DELETE CASCADE, so deleting the
 * demo user's transactions would delete marks on them. It can't reach another
 * user: that key is (transactionId, userId) -> Transaction(id, userId), so the
 * database refuses any mark whose user isn't its transaction's user, and every
 * mark on a demo transaction is the demo user's own. (POST /subscriptions/marks
 * also checks ownership before writing; the key is what makes this hold even if
 * that check were wrong.) The wipe deletes the demo user's marks explicitly
 * first anyway, so the cascade has nothing left to do. Every other foreign key
 * is ON DELETE RESTRICT, so a delete can only ever fail, never spread. Every
 * write is a create, never an upsert or update of anyone else's row; the one
 * upsert is the demo User row itself. The non-demo baseline, checked inside
 * the transaction, would catch a cascade that reached anyone else.
 *
 * No alerts are seeded. The detectors produce real ones from this data on the
 * first bell open. The old seed inserted kinds no detector owns, which nothing
 * could ever resolve, so they sat in the demo bell permanently.
 *
 * Run:
 *   local:       cd backend && npm run db:dev:seed           (add -- --dry-run to preview)
 *   production:  railway run npx tsx prisma/seed-demo.ts --allow-remote <db host> --dry-run
 *                then the same without --dry-run
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { DEMO_USER_ID, buildDemoDataset } from './demo-dataset'
import { SENTINEL_TOKEN, buildPlan, type Plan } from './demo-plan'
import { CREATE_ORDER, WIPE_ORDER } from './demo-tables'
import { connectReadOnly, hasFlag, makeRefuse, redact, resolveConnection } from '../scripts/lib/read-only-db'
import {
  NON_DEMO_TABLES, diffBaselines, summariseBaseline, takeBaseline, type BaselineEntry, type RawQuerier,
} from '../scripts/lib/non-demo-baseline'

export { DEMO_USER_ID }

const SCRIPT = 'seed-demo'
const refuse: (message: string) => never = makeRefuse(SCRIPT)

/**
 * The transaction's time limit. Chosen from measurement, not guessed:
 *
 *   Measured locally (3 runs): inside the transaction ~0.25 s — 41 round trips
 *   at ~1 ms, the rest server work, mostly the 543-row insert. Engine start and
 *   connecting (~2 s) happen BEFORE the transaction and don't count against it.
 *   The rebuild sends ~400 KB, almost all of it transaction rawJson.
 *
 *   Remote, the cost is round trips × RTT, plus the upload:
 *     100 ms RTT, 5 Mbps up (ordinary connection)   41×0.10 + 0.2 + 0.7 ≈  5 s
 *     250 ms RTT, 1 Mbps up (bad Wi-Fi)             41×0.25 + 0.2 + 3.3 ≈ 14 s
 *   Prisma's default of 5 s would fail on an ordinary connection.
 *
 *   60 s is ~4× the bad case. It is also a ceiling that matters: a transaction
 *   left hanging holds locks on the demo rows it deleted, and a visitor opening
 *   the bell writes demo alert rows, which would wait on them. 60 s bounds that.
 *
 * The dry run measures this connection's actual round trip and prints the
 * projection against this limit, before anything is written.
 */
const TX_TIMEOUT_MS = 60_000
/** How long to wait for a connection to start the transaction on. */
const TX_MAX_WAIT_MS = 15_000

// WIPE_ORDER and CREATE_ORDER live in demo-tables.ts, where a test checks them.

/**
 * Round trips inside the transaction. An interactive transaction pays one per
 * statement, so this — not the row count — is what a remote connection makes
 * slow:
 *   baseline before + after   NON_DEMO_TABLES × 2
 *   wipe                      WIPE_ORDER
 *   demo User upsert          1
 *   rebuild                   CREATE_ORDER (createMany: one statement per table)
 *   demo count check          NON_DEMO_TABLES (same tables, demo side)
 *   BEGIN, SET ISOLATION, COMMIT  3
 */
const TX_STATEMENTS =
  NON_DEMO_TABLES.length * 2 + WIPE_ORDER.length + 1 + CREATE_ORDER.length + NON_DEMO_TABLES.length + 3

/** Rows the plan creates, per table, in the same shape as demoCounts(). */
function plannedCounts(plan: Plan): Record<string, number> {
  return {
    User: 1,
    PlaidItem: plan.plaidItem.length,
    Account: plan.account.length,
    Transaction: plan.transaction.length,
    Budget: plan.budget.length,
    BalanceSnapshot: plan.balanceSnapshot.length,
    Alert: 0,
    Goal: plan.goal.length,
    SubscriptionMark: plan.subscriptionMark.length,
    RecurringStream: plan.recurringStream.length,
  }
}

/** The demo user's rows, per table. */
async function demoCounts(db: RawQuerier): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [table, owner] of NON_DEMO_TABLES) {
    const [r] = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${owner}" = $1`,
      DEMO_USER_ID,
    )
    out[table] = Number(r.n)
  }
  return out
}

function printTable(title: string, rows: Array<Record<string, string | number>>): void {
  console.log(title)
  const cols = Object.keys(rows[0])
  const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]))
  console.log('  ' + cols.map((c) => c.padEnd(w[c])).join('  '))
  console.log('  ' + cols.map((c) => '─'.repeat(w[c])).join('  '))
  for (const r of rows) console.log('  ' + cols.map((c) => String(r[c]).padEnd(w[c])).join('  '))
  console.log()
}

function printBaseline(entries: BaselineEntry[]): void {
  printTable('Everyone else — must come through unchanged (non-demo rows, per table):',
    summariseBaseline(entries).map((s) => ({ table: s.table, users: s.users, rows: s.rows })))
  const users = [...new Set(entries.map((e) => e.user))]
  for (const u of users) {
    const mine = entries.filter((e) => e.user === u)
    console.log(`  user ${u.slice(0, 12)}…  ` + mine.map((e) => `${e.table} ${e.rows}`).join(', '))
  }
  console.log()
}

/** "Plaintext sentinel", "looks encrypted", or "unrecognised". Never the value. */
function describeToken(token: string): string {
  if (token === SENTINEL_TOKEN) return `plaintext sentinel '${SENTINEL_TOKEN}'`
  if (/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(token)) return 'looks encrypted (iv:tag:ciphertext)'
  return 'unrecognised format (value not shown)'
}

// ── dry run: read-only, the database itself refuses writes ──────────

async function dryRun(plan: Plan): Promise<void> {
  const db = await connectReadOnly(SCRIPT)
  console.log(`\n${SCRIPT} — DRY RUN, nothing will be written`)
  console.log(`  target  ${db.database} on ${db.host} via ${db.envName}`)
  console.log(`  proof   ${db.writeRefusedWith}\n`)

  const current = await demoCounts(db.prisma)
  const planned = plannedCounts(plan)
  printTable('The demo user (demo-user) — deleted, then created:', NON_DEMO_TABLES.map(([t]) => ({
    table: t,
    'now (deleted)': t === 'User' ? `${current[t]} (kept, upserted)` : current[t],
    'after (created)': planned[t],
  })))

  const tokens = await db.prisma.plaidItem.findMany({ where: { userId: DEMO_USER_ID }, select: { itemId: true, accessToken: true } })
  console.log('Demo PlaidItem access tokens in this database now:')
  if (tokens.length === 0) console.log('  (no demo items)')
  for (const t of tokens) console.log(`  ${t.itemId}: ${describeToken(t.accessToken)}`)
  console.log()

  printBaseline(await takeBaseline(db.prisma))

  // Round trip, measured rather than assumed: the transaction's cost on this
  // connection is roughly one round trip per statement.
  const samples: number[] = []
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now()
    await db.prisma.$queryRawUnsafe('SELECT 1')
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const rtt = samples[Math.floor(samples.length / 2)]
  const worst = samples[samples.length - 1]
  const projected = TX_STATEMENTS * worst
  console.log('Transaction time budget:')
  console.log(`  round trip here     median ${rtt.toFixed(0)} ms, worst of 7 ${worst.toFixed(0)} ms`)
  console.log(`  statements in tx    ${TX_STATEMENTS}`)
  console.log(`  projected           ~${(projected / 1000).toFixed(1)} s at the worst round trip, plus row payload`)
  console.log(`  timeout             ${TX_TIMEOUT_MS / 1000} s  (${(TX_TIMEOUT_MS / Math.max(projected, 1)).toFixed(0)}× the projection)`)
  console.log('\nDry run complete. Nothing was written.\n')
  await db.prisma.$disconnect()
}

// ── the real thing ──────────────────────────────────────────────────

class BaselineChanged extends Error {}

async function write(plan: Plan): Promise<void> {
  const conn = resolveConnection(SCRIPT)
  console.log(`\n${SCRIPT} — writing to ${conn.url.pathname.replace(/^\//, '')} on ${conn.host} via ${conn.envName}`)

  // Its own client on exactly the resolved URL: the shared one reads
  // DATABASE_URL, which may name a different (pooled) connection.
  const prisma = new PrismaClient({ datasourceUrl: conn.url.toString() })
  const planned = plannedCounts(plan)
  const timings: Record<string, number> = {}
  const t0 = performance.now()
  let mark = t0
  const lap = (name: string) => {
    const t = performance.now()
    timings[name] = t - mark
    mark = t
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Engine start and connecting happen before this point, outside the
        // transaction's timeout; everything after is inside it.
        lap('connect + begin')
        const before = await takeBaseline(tx)
        lap('baseline before')

        const deleted: Record<string, number> = {}
        for (const table of WIPE_ORDER) {
          // Every one scoped to the demo user. DEMO_USER_ID is a string literal.
          deleted[table] = (await (tx[table] as any).deleteMany({ where: { userId: DEMO_USER_ID } })).count
        }
        lap('wipe')

        await tx.user.upsert({
          where: { id: DEMO_USER_ID },
          update: { periodStartDay: plan.dataset.startDay },
          create: { id: DEMO_USER_ID, email: 'demo@ledger.app', periodStartDay: plan.dataset.startDay },
        })
        for (const table of CREATE_ORDER) {
          try {
            await (tx[table] as any).createMany({ data: plan[table] })
          } catch (e: any) {
            // Say which table: Prisma's message names the field, not the table.
            const reason = String(e?.message ?? e).split('\n').map((l: string) => l.trim()).filter(Boolean)
            throw new Error(`creating ${plan[table].length} ${table} row(s) failed: ${reason[reason.length - 1] ?? 'unknown error'}`)
          }
        }
        lap('rebuild')

        // Everyone else, again, in the same snapshot. Any difference rolls it all back.
        const after = await takeBaseline(tx)
        const damage = diffBaselines(before, after)
        lap('baseline after')
        if (damage.length > 0) {
          throw new BaselineChanged(
            `non-demo rows changed, so nothing was committed:\n  ${damage.join('\n  ')}`,
          )
        }

        const written = await demoCounts(tx)
        const short = Object.keys(planned).filter((t) => written[t] !== planned[t])
        if (short.length > 0) {
          throw new Error(
            `the demo user's rows don't match the plan, so nothing was committed: ` +
            short.map((t) => `${t} ${written[t]} ≠ ${planned[t]}`).join(', '),
          )
        }
        lap('demo check')
        return { before, deleted, written }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: TX_TIMEOUT_MS,
        maxWait: TX_MAX_WAIT_MS,
      },
    )
    const total = performance.now() - t0

    console.log('  committed.\n')
    printTable('The demo user — deleted, then created:', NON_DEMO_TABLES.map(([t]) => ({
      table: t,
      deleted: t === 'User' ? '(kept)' : result.deleted[t[0].toLowerCase() + t.slice(1)] ?? 0,
      created: result.written[t],
    })))
    printBaseline(result.before)
    console.log('  Non-demo rows: identical before and after, checked inside the transaction before commit.')
    console.log(`  Time: ${(total / 1000).toFixed(2)} s for ${TX_STATEMENTS} statements (` +
      Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ') + ')')
    console.log(`  Classifier fixtures: ${plan.dataset.cases.length} named cases.\n`)
  } catch (e: any) {
    console.error(`\n✗ ${SCRIPT}: rolled back. The demo user's previous data is unchanged.`)
    console.error(`  ${redact(String(e?.message ?? e)).split('\n').join('\n  ')}\n`)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const plan = buildPlan(buildDemoDataset(new Date()))
  if (hasFlag('dry-run')) await dryRun(plan)
  else await write(plan)
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)))
  process.exit(1)
})
