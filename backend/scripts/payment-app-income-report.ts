// ─────────────────────────────────────────────────────────────────
//  payment-app-income-report — what the paymentAppInflowsAreIncome setting
//  would do to YOUR figures, before you turn it on.
//
//  Reads one user's transactions and prints income, spend, savings rate and
//  financial score with the setting off and on, side by side, and attributes
//  every difference to the rows that caused it. Nothing is saved: the stored
//  setting is not touched and no row is written. Same discipline as the M7.3
//  reconciler — a difference that can't be named is reported as unexplained.
//
//  SAFE TO POINT AT PRODUCTION. It opens the database with
//  default_transaction_read_only=on, proves that took effect by attempting a
//  write that must fail, and refuses to go on if either check doesn't hold.
//
//  Local (demo data):
//    npm run db:guard && npx dotenv -e .env.dev -- tsx scripts/payment-app-income-report.ts --user demo-user
//  Production, read-only (Railway injects the connection):
//    railway run npx tsx scripts/payment-app-income-report.ts --user <id> --allow-remote <db host>
// ─────────────────────────────────────────────────────────────────

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const PERIODS = 12

function flag(name: string): string | undefined {
  const args = process.argv.slice(2)
  const i = args.indexOf(`--${name}`)
  if (i >= 0) return args[i + 1]
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function refuse(message: string): never {
  console.error(`✗ payment-app-income-report refused: ${message}`)
  process.exit(1)
}

/** The same URL, asking Postgres to make every transaction read-only. */
function readOnlyUrl(raw: string): { url: string; host: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    refuse('DATABASE_URL is not a valid URL.')
  }
  // Postgres accepts startup options on the connection string. A connection
  // pooler in transaction mode may ignore them, which is why this is verified
  // rather than trusted.
  parsed.searchParams.set('options', '-c default_transaction_read_only=on')
  return { url: parsed.toString(), host: parsed.hostname.toLowerCase() }
}

const money = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`)
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const user = flag('user')
  if (!user || user.startsWith('--')) refuse('--user <id> is required.')

  const { url, host } = readOnlyUrl(process.env.DATABASE_URL ?? refuse('DATABASE_URL is not set.'))
  const allowRemote = flag('allow-remote')?.toLowerCase()
  if (!LOCAL_HOSTNAMES.has(host) && allowRemote !== host) {
    refuse(`DATABASE_URL points at "${host}", which is not local. To read from there, pass --allow-remote ${host}.`)
  }
  process.env.DATABASE_URL = url

  // Imported only after the URL is replaced: the shared client reads it once.
  const { default: prisma } = await import('../src/lib/prisma')
  const [{ read_only }] = await prisma.$queryRawUnsafe<Array<{ read_only: string }>>(
    "SELECT current_setting('default_transaction_read_only') AS read_only",
  )
  if (read_only !== 'on') {
    refuse(
      'the connection is not read-only (a pooler may have dropped the option). ' +
      'Use the direct connection, not the pooled one, and try again.',
    )
  }
  // Belt and braces: a statement that writes nothing but must still be refused.
  let writesRefused = false
  try {
    await prisma.$executeRawUnsafe('UPDATE "User" SET "periodStartDay" = "periodStartDay" WHERE false')
  } catch {
    writesRefused = true
  }
  if (!writesRefused) refuse('a write was accepted on a connection that claims to be read-only.')

  const { recentPeriods, fromDateKey, periodKeyOf } = await import('../src/lib/period')
  const { classifyWindow, withClassifierSettings, incomeForPeriod, spendForPeriod, savingsRateFor } =
    await import('../src/services/classification.service')
  const { fetchFinancialScore } = await import('../src/services/score.service')
  const { getPeriodStartDay } = await import('../src/services/user.service')
  const { isPaymentAppRepayment } = await import('../src/lib/classifier')

  const stored = await prisma.user.findUnique({
    where: { id: user },
    select: { paymentAppInflowsAreIncome: true },
  })
  if (!stored) refuse(`no user "${user}" in this database.`)
  const startDay = await getPeriodStartDay(user)
  const periods = recentPeriods(new Date(), startDay, PERIODS)

  const measure = (on: boolean) =>
    withClassifierSettings({ paymentAppInflowsAreIncome: on }, async () => {
      const { rows, paymentAppByPeriod } = await classifyWindow(user, {
        since: fromDateKey(periods[0].start),
        until: fromDateKey(periods[periods.length - 1].end),
        startDay,
      })
      const completed: number[] = []
      const byPeriod = periods.map((p) => {
        const income = incomeForPeriod(rows, p.key, startDay)
        const spend = spendForPeriod(rows, p.key, startDay, paymentAppByPeriod)
        const rate = savingsRateFor(income, round2(income - spend), completed)
        if (p !== periods[periods.length - 1]) completed.push(income)
        return { key: p.key, income, spend, netSaved: round2(income - spend), rate }
      })
      // The rows this setting moves, and the cap total that moves with them.
      const moved = rows.filter((r) => isPaymentAppRepayment(r.verdict))
      const movedByPeriod = new Map<string, { count: number; total: number }>()
      for (const r of moved) {
        const key = periodKeyOf(r.date, startDay)
        const cur = movedByPeriod.get(key) ?? { count: 0, total: 0 }
        movedByPeriod.set(key, { count: cur.count + 1, total: round2(cur.total + -r.amount) })
      }
      return { byPeriod, movedByPeriod, score: await fetchFinancialScore(user) }
    })

  const off = await measure(false)
  const on = await measure(true)

  console.log(`\npayment-app income setting — ${user} on ${host}`)
  console.log(`stored setting: ${stored.paymentAppInflowsAreIncome ? 'ON' : 'off'} (unchanged by this report)`)
  console.log(`money periods start on day ${startDay}; last ${PERIODS} periods\n`)

  const head = ['period', 'income off', 'income on', 'spend off', 'spend on', 'rate off', 'rate on', 'rows moved']
  const rowsOut: string[][] = []
  const unexplained: string[] = []
  let totalMoved = 0

  off.byPeriod.forEach((o, i) => {
    const n = on.byPeriod[i]
    const moved = off.movedByPeriod.get(o.key) ?? { count: 0, total: 0 }
    if (o.income === n.income && o.spend === n.spend && moved.count === 0) return
    totalMoved += moved.total
    rowsOut.push([
      o.key, money(o.income), money(n.income), money(o.spend), money(n.spend),
      pct(o.rate.rate), pct(n.rate.rate), `${moved.count} · ${money(moved.total)}`,
    ])

    // Attribution. Income must move by exactly the inflows that changed side.
    const incomeDelta = round2(n.income - o.income)
    if (Math.abs(incomeDelta - moved.total) >= 0.01) {
      unexplained.push(`${o.key}: income moved ${money(incomeDelta)} but the rows that changed total ${money(moved.total)}`)
    }
    // Spend rises by the part of the inflow the cap was absorbing, never more
    // than that period's payment-app outflows.
    const spendDelta = round2(n.spend - o.spend)
    if (spendDelta < -0.005 || spendDelta - moved.total > 0.005) {
      unexplained.push(`${o.key}: spend moved ${money(spendDelta)}, which is outside 0…${money(moved.total)}`)
    }
  })

  if (rowsOut.length === 0) {
    console.log('No period changes: this account has no payment-app money in over these periods.\n')
  } else {
    const widths = head.map((h, i) => Math.max(h.length, ...rowsOut.map((r) => r[i].length)))
    const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i])).join('  ')
    console.log(line(head))
    console.log(widths.map((w) => '─'.repeat(w)).join('  '))
    rowsOut.forEach((r) => console.log(line(r)))
    console.log(`\nMoney that changes side, all periods: ${money(round2(totalMoved))}`)
    console.log('Income rises by that amount. Spend rises by the part of it the cap was absorbing;')
    console.log('the rest is money that counted nowhere at all before (a dropped surplus).')
  }

  console.log(`\nFinancial score: ${off.score.total} (${off.score.grade})  →  ${on.score.total} (${on.score.grade})`)
  for (const key of Object.keys(off.score.components) as Array<keyof typeof off.score.components>) {
    const a = off.score.components[key], b = on.score.components[key]
    if (a.value === b.value) continue
    console.log(`  ${key}: ${a.value ?? '—'} → ${b.value ?? '—'}`)
  }

  console.log(
    unexplained.length === 0
      ? '\nEvery difference is accounted for by the rows that changed side.'
      : `\n⚠ ${unexplained.length} unexplained difference(s):\n  ${unexplained.join('\n  ')}`,
  )
  console.log()

  await prisma.$disconnect()
  if (unexplained.length > 0) process.exit(2)
}

main().catch((e) => { console.error(e); process.exit(1) })
