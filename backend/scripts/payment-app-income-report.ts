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
//  It reads DIRECT_URL by default, falling back to DATABASE_URL, because
//  DATABASE_URL is usually the pooled connection and a pooler in transaction
//  mode drops the read-only option. --url-env NAME picks another variable, and
//  --allow-remote names the host of the URL actually being read.
//
//  Local (demo data):
//    npm run db:guard && npx dotenv -e .env.dev -- tsx scripts/payment-app-income-report.ts --user demo-user
//  Production, read-only (Railway injects the connection):
//    railway run npx tsx scripts/payment-app-income-report.ts --user <id> --allow-remote <direct db host>
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

/**
 * Which environment variable holds the connection to read.
 *
 * DIRECT_URL first, because DATABASE_URL is usually a pooled connection and a
 * pooler in transaction mode drops the startup option this script relies on —
 * which used to leave the run refusing with advice ("use the direct
 * connection") that no flag could act on. `--url-env NAME` overrides.
 */
function pickUrlEnv(): { name: string; raw: string } {
  const asked = flag('url-env')
  if (asked) {
    const raw = process.env[asked]
    if (!raw) refuse(`--url-env ${asked} was given, but ${asked} is not set in this environment.`)
    return { name: asked, raw }
  }
  if (process.env.DIRECT_URL) return { name: 'DIRECT_URL', raw: process.env.DIRECT_URL }
  if (process.env.DATABASE_URL) return { name: 'DATABASE_URL', raw: process.env.DATABASE_URL }
  refuse('neither DIRECT_URL nor DATABASE_URL is set. Supply the environment explicitly, or pass --url-env NAME.')
}

/** The same URL, asking Postgres to make every transaction read-only. */
function readOnlyUrl(raw: string, envName: string): { url: string; host: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    refuse(`${envName} is not a valid URL.`)
  }
  // Postgres accepts startup options on the connection string. A connection
  // pooler in transaction mode may ignore them, which is why this is verified
  // rather than trusted. One connection, so what is verified is what is used.
  parsed.searchParams.set('options', '-c default_transaction_read_only=on')
  parsed.searchParams.set('connection_limit', '1')
  return { url: parsed.toString(), host: parsed.hostname.toLowerCase() }
}

const money = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`)
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const user = flag('user')
  if (!user || user.startsWith('--')) refuse('--user <id> is required.')

  const chosen = pickUrlEnv()
  const { url, host } = readOnlyUrl(chosen.raw, chosen.name)
  const allowRemote = flag('allow-remote')?.toLowerCase()
  if (!LOCAL_HOSTNAMES.has(host) && allowRemote !== host) {
    refuse(
      `${chosen.name} points at "${host}", which is not local. To read from there, pass --allow-remote ${host}.` +
      (chosen.name === 'DIRECT_URL' ? '\n  (Reading DIRECT_URL, not DATABASE_URL — the host to name is this one.)' : ''),
    )
  }
  // The shared Prisma client reads DATABASE_URL, whichever variable the URL came from.
  process.env.DATABASE_URL = url

  // Imported only after the URL is replaced: the shared client reads it once.
  const { default: prisma } = await import('../src/lib/prisma')
  let read_only: string
  try {
    ;[{ read_only }] = await prisma.$queryRawUnsafe<Array<{ read_only: string }>>(
      "SELECT current_setting('default_transaction_read_only') AS read_only",
    )
  } catch (e: any) {
    // A direct Supabase host is IPv6-only unless the IPv4 add-on is enabled, so
    // it can be unreachable from a place where the pooled host works fine.
    refuse(
      `could not connect using ${chosen.name} (${host}): ${e.code ?? e.message}
  If that host is unreachable from here, use a SESSION-mode pooler connection (port 5432
  on the pooler host, not 6543): session mode keeps the read-only option that transaction
  mode drops. Put it in an env var, then pass --url-env NAME --allow-remote <that host>.`,
    )
  }
  if (read_only !== 'on') {
    const others = ['DIRECT_URL', 'DATABASE_URL'].filter((n) => n !== chosen.name && process.env[n])
    refuse(
      `${chosen.name} (${host}) dropped the read-only option, which a connection pooler in\n` +
      '  transaction mode does. This needs a direct (session) connection.\n' +
      (others.length > 0
        ? `  Try: --url-env ${others[0]}  — and pass --allow-remote for THAT host, not this one.`
        : '  Set DIRECT_URL to the direct connection (Supabase: Project Settings → Database →\n' +
          '  Connection string → Direct connection), then re-run.'),
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
  const { isCappedPaymentApp, isPaymentAppRepayment } = await import('../src/lib/classifier')

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
      const paymentAppRows = rows
        .filter((r) => isCappedPaymentApp(r.verdict))
        .map((r) => ({ date: r.date, amount: r.amount, merchantLabel: r.merchantLabel }))
      return { byPeriod, movedByPeriod, paymentAppRows, score: await fetchFinancialScore(user) }
    })

  const off = await measure(false)
  const on = await measure(true)

  console.log(`\npayment-app income setting — ${user} on ${host} (${chosen.name}, read-only)`)
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

  // ── Where the money in comes from ───────────────────────────────
  //
  // The setting counts every payment-app inflow as income. That is right for a
  // roommate sending rent and wrong for your own balance coming back: if you
  // top up Venmo from your bank and later cash out, the rules cannot tell the
  // two apart. This section is how you find out whether that happens to you,
  // and how much of the money is it — which is what a per-row override would
  // have to cover.
  //
  // Two signals, kept apart because they say different things:
  //   ROUND-TRIP — an earlier outflow to the same app, same amount, within 30
  //                days. Evidence that this particular money is yours coming
  //                back, and the stronger of the two.
  //   NAME       — the row is called a cash-out or a transfer. That only means
  //                the money came out of your app BALANCE rather than straight
  //                from a person, and a balance can hold other people's
  //                payments, your own top-ups, or both. So a named row means
  //                "can't tell from here", not "your own money".
  const inflows = off.paymentAppRows.filter((r) => r.amount < 0)
  const outflows = off.paymentAppRows.filter((r) => r.amount > 0)
  const CASH_OUT_NAME = /cash\s?out|cashout|withdraw|transfer (in|from|to)|to bank|instant transfer/i
  const APPS = ['venmo', 'zelle', 'cash app', 'cashapp', 'paypal', 'apple cash', 'square']
  const appOf = (label: string) => APPS.find((a) => label.toLowerCase().includes(a)) ?? null
  const ROUND_TRIP_DAYS = 30

  const suspects = inflows.map((r) => {
    const app = appOf(r.merchantLabel)
    const roundTrip = app !== null && outflows.some(
      (o) =>
        appOf(o.merchantLabel) === app &&
        Math.abs(o.amount + r.amount) < 0.01 &&
        o.date <= r.date &&
        r.date.getTime() - o.date.getTime() <= ROUND_TRIP_DAYS * 86_400_000,
    )
    return { ...r, amount: -r.amount, byName: CASH_OUT_NAME.test(r.merchantLabel), roundTrip }
  })
  const flagged = suspects.filter((s) => s.byName || s.roundTrip)
  const sum = (rows: Array<{ amount: number }>) => round2(rows.reduce((t, r) => t + r.amount, 0))

  console.log('\n── Where the money in comes from ──────────────────────────')
  const byName = new Map<string, { count: number; total: number; byName: boolean; roundTrip: number }>()
  for (const s of suspects) {
    const cur = byName.get(s.merchantLabel) ?? { count: 0, total: 0, byName: s.byName, roundTrip: 0 }
    byName.set(s.merchantLabel, {
      count: cur.count + 1,
      total: round2(cur.total + s.amount),
      byName: cur.byName || s.byName,
      roundTrip: cur.roundTrip + (s.roundTrip ? 1 : 0),
    })
  }
  for (const [label, v] of [...byName.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const marks = [v.byName ? 'named like a cash-out' : null, v.roundTrip > 0 ? `${v.roundTrip} round-trip` : null]
      .filter(Boolean).join(', ')
    console.log(`  ${money(v.total).padStart(11)}  ${String(v.count).padStart(4)} rows  ${label}${marks ? `   ← ${marks}` : ''}`)
  }
  const roundTrips = suspects.filter((s) => s.roundTrip)
  const namedOnly = suspects.filter((s) => s.byName && !s.roundTrip)
  console.log(`\n  Money in through payment apps, total:     ${money(sum(suspects))}  (${suspects.length} rows)`)
  console.log(`  Your own money coming back (round-trip): ${money(sum(roundTrips))}  (${roundTrips.length} rows)`)
  console.log(`  Out of an app balance, source unknown:   ${money(sum(namedOnly))}  (${namedOnly.length} rows)`)
  if (flagged.length > 0) {
    console.log('\n  With the setting on, all of it counts as income. The round-trip rows are money you')
    console.log('  already had. The "source unknown" rows could be either, and are the ones to check one')
    console.log('  by one — they are what a per-transaction override would be for.')
    console.log('  Biggest ones:')
    for (const s of [...flagged].sort((a, b) => b.amount - a.amount).slice(0, 8)) {
      const why = [s.byName ? 'name' : null, s.roundTrip ? 'round-trip' : null].filter(Boolean).join('+')
      console.log(`    ${s.date.toISOString().slice(0, 10)}  ${money(s.amount).padStart(10)}  ${s.merchantLabel}  (${why})`)
    }
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
