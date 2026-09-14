// URL search-param writer race — regression test.
// See README.md in this directory for what it simulates and its limits.
//
// Runs every scenario against two implementations:
//   raw    — the pre-helper code: DemoUrlSync as of c421dbe5 and TransactionList's
//            writer as of 9364dab3, both writing via React Router's setSearchParams.
//            Kept deliberately, to prove the scenarios can detect the bug.
//   helper — the same components writing through the REAL frontend/src/lib/useUrlParams.ts.
//
// Exit code 1 if any scenario's outcome differs from what is asserted below.
// Usage: node scripts/url-params-repro/run.mjs [--verbose]

import { JSDOM } from 'jsdom'

const VERBOSE = process.argv.includes('--verbose')

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/transactions?demo=1',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 24 defines a read-only global navigator, so plain assignment throws.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { BrowserRouter, Routes, Route, useSearchParams, useNavigate, useLocation } = await import('react-router-dom')
const { useUrlParams } = await import('../../src/lib/useUrlParams.ts')

const { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, Fragment } = React
const act = React.act
const h = React.createElement
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DEMO = 'demo'
const DEFAULTS = { q: '', category: 'All', dateFrom: '', dateTo: '' }

let G = {}
let log = []
let lastState = null
let t0 = 0

const now = () => Math.round(performance.now() - t0)
const mark = (label) => log.push({ ms: now(), mark: label })

// Waits run in 25ms act() slices so timer-driven updates commit within ~25ms of
// firing; one long act() would defer every update to its end.
async function settle(ms) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    await act(async () => { await sleep(25) })
  }
}

function record() {
  const entry = {
    ms: now(),
    path: window.location.pathname,
    url: window.location.search || '(none)',
    input: G.view ? G.view.input : null,
    effectiveQ: G.view ? G.view.effectiveQ : null,
    demoState: G.demoMode,
  }
  const keys = ['path', 'url', 'input', 'effectiveQ', 'demoState']
  if (lastState && keys.every((k) => lastState[k] === entry[k])) return
  log.push(entry)
  lastState = entry
}

// ── DemoUrlSync ──────────────────────────────────────────────────
// raw: frontend/src/DemoUrlSync.tsx as of c421dbe5
function DemoUrlSyncRaw({ demoMode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  G.demoSP = searchParams
  G.demoSet = setSearchParams
  useEffect(() => {
    if ((searchParams.get(DEMO) === '1') === demoMode) return
    const next = new URLSearchParams(searchParams)
    if (demoMode) next.set(DEMO, '1')
    else next.delete(DEMO)
    setSearchParams(next, { replace: true })
  }, [demoMode, searchParams, setSearchParams])
  return null
}

// helper: frontend/src/DemoUrlSync.tsx writing through useUrlParams
function DemoUrlSyncHelper({ demoMode }) {
  const [searchParams, writeParams] = useUrlParams()
  G.demoWrite = writeParams
  const inUrl = searchParams.get(DEMO) === '1'
  useEffect(() => {
    if (inUrl === demoMode) return
    writeParams({ [DEMO]: demoMode ? '1' : null })
  }, [demoMode, inUrl, writeParams])
  return null
}

// ── TransactionList (URL-writer logic only) ──────────────────────
function List({ impl }) {
  // Both hooks are always called so hook order never depends on impl.
  const [rawParams, rawSet] = useSearchParams()
  const [helperParams, writeParams] = useUrlParams()
  const searchParams = impl === 'raw' ? rawParams : helperParams

  const q = searchParams.get('q') ?? DEFAULTS.q
  const category = searchParams.get('category') ?? DEFAULTS.category
  const dateFrom = searchParams.get('dateFrom') ?? DEFAULTS.dateFrom
  const dateTo = searchParams.get('dateTo') ?? DEFAULTS.dateTo
  const filters = useMemo(() => ({ q, category, dateFrom, dateTo }), [q, category, dateFrom, dateTo])

  const setFilter = useCallback((patch) => {
    if (impl === 'raw') {
      // TransactionList.tsx as of 9364dab3
      rawSet((prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value === DEFAULTS[key]) next.delete(key)
          else next.set(key, value)
        }
        return next
      }, { replace: true })
    } else {
      // TransactionList.tsx writing through useUrlParams
      const out = {}
      for (const [key, value] of Object.entries(patch)) out[key] = value === DEFAULTS[key] ? null : value
      writeParams(out)
    }
  }, impl === 'raw' ? [impl, rawSet] : [impl, writeParams])

  const [searchInput, setSearchInput] = useState(q)

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== q) setFilter({ q: searchInput })
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput, q, setFilter])

  useEffect(() => {
    setSearchInput((prev) => (prev === q ? prev : q))
  }, [q])

  G.setFilter = setFilter
  G.setSearchInput = setSearchInput
  G.view = { effectiveQ: filters.q, input: searchInput }

  useLayoutEffect(() => { record() })
  useLayoutEffect(() => () => { G.view = null }, [])
  return null
}

// ── A Budgets-shaped third writer ────────────────────────────────
// The two ways a save handler naturally gets written:
//   save()  — writes a URL param after an await (patterns P1, P1b)
//   'deps'  — a timer effect with the setter omitted from its dependency list (P2-deps)
//   'ref'   — the setter captured into a ref once and never refreshed (P2-ref)
function BudgetsLike({ impl, pattern }) {
  const [, rawSet] = useSearchParams()
  const [, writeParams] = useUrlParams()
  const setter = impl === 'raw' ? rawSet : writeParams
  const setMonth = (s) => (impl === 'raw'
    ? s((prev) => { const n = new URLSearchParams(prev); n.set('month', '2026-09'); return n }, { replace: true })
    : s({ month: '2026-09' }))

  G.budgetsSave = async () => {
    await sleep(200)
    setMonth(setter)
  }

  useEffect(() => {
    if (pattern !== 'deps') return
    const t = setTimeout(() => setMonth(setter), 300)
    return () => clearTimeout(t)
  }, []) // setter deliberately omitted

  const held = useRef(null)
  if (held.current === null) held.current = setter
  useEffect(() => {
    if (pattern !== 'ref') return
    const t = setTimeout(() => setMonth(held.current), 300)
    return () => clearTimeout(t)
  }, [])

  return null
}

function Probe() {
  useLocation()
  useLayoutEffect(() => { record() })
  return null
}

function Root({ impl, budgets }) {
  const [demoMode, setDemoMode] = useState(true)
  G.setDemoMode = setDemoMode
  G.demoMode = demoMode
  G.navigate = useNavigate()
  const Sync = impl === 'raw' ? DemoUrlSyncRaw : DemoUrlSyncHelper
  return h(Fragment, null,
    h(Sync, { demoMode }),
    h(Routes, null,
      h(Route, {
        path: '/transactions',
        element: h(Fragment, null,
          h(List, { impl }),
          budgets ? h(BudgetsLike, { impl, pattern: budgets }) : null),
      }),
      h(Route, { path: '/accounts', element: h(Fragment) }),
    ),
    h(Probe),
  )
}

// ── Scenarios ────────────────────────────────────────────────────
const typeAmaz = () => act(async () => { G.setSearchInput('amaz') })

const SCENARIOS = [
  {
    id: '0', title: 'natural: type, exit demo 100ms later',
    expect: { path: '/transactions', params: { q: 'amaz' }, input: 'amaz', demoState: false },
    drive: async () => {
      await typeAmaz()
      await settle(100)
      mark('exit demo')
      await act(async () => { G.setDemoMode(false) })
    },
  },
  {
    id: '0b', title: 'natural: type, demo off then immediately on',
    expect: { path: '/transactions', params: { demo: '1', q: 'amaz' }, input: 'amaz', demoState: true },
    drive: async () => {
      await typeAmaz()
      await settle(100)
      mark('demo off')
      await act(async () => { G.setDemoMode(false) })
      mark('demo on')
      await act(async () => { G.setDemoMode(true) })
    },
  },
  {
    id: 'A', title: 'forced collision: exit-demo write, then search write, one flush',
    expect: { path: '/transactions', params: { q: 'amaz' }, input: 'amaz', demoState: false },
    drive: async (impl) => {
      await typeAmaz()
      mark('COLLISION')
      await act(async () => {
        const setFilter = G.setFilter
        if (impl === 'raw') {
          const sp = G.demoSP
          const demoSet = G.demoSet
          G.setDemoMode(false)
          const next = new URLSearchParams(sp)
          next.delete(DEMO)
          demoSet(next, { replace: true })
        } else {
          const demoWrite = G.demoWrite
          G.setDemoMode(false)
          demoWrite({ [DEMO]: null })
        }
        setFilter({ q: 'amaz' })
      })
    },
  },
  {
    id: 'B', title: 'forced collision: search write, then exit-demo write, one flush',
    expect: { path: '/transactions', params: { q: 'amaz' }, input: 'amaz', demoState: false },
    drive: async (impl) => {
      await typeAmaz()
      mark('COLLISION')
      await act(async () => {
        const setFilter = G.setFilter
        const sp = G.demoSP
        const demoSet = G.demoSet
        const demoWrite = G.demoWrite
        G.setDemoMode(false)
        setFilter({ q: 'amaz' })
        if (impl === 'raw') {
          const next = new URLSearchParams(sp)
          next.delete(DEMO)
          demoSet(next, { replace: true })
        } else {
          demoWrite({ [DEMO]: null })
        }
      })
    },
  },
  {
    id: 'C', title: 'stale write from before q committed, with a demo toggle',
    expect: { path: '/transactions', params: { q: 'amaz' }, input: 'amaz', demoState: false },
    drive: async (impl) => {
      const staleSP = G.demoSP
      const staleSet = G.demoSet
      const staleWrite = G.demoWrite
      await typeAmaz()
      await settle(450)
      mark('stale write + demo toggle')
      await act(async () => {
        G.setDemoMode(false)
        if (impl === 'raw') {
          const next = new URLSearchParams(staleSP)
          next.delete(DEMO)
          staleSet(next, { replace: true })
        } else {
          staleWrite({ [DEMO]: null })
        }
      })
    },
  },
  {
    id: 'C2', title: 'stale write from before q committed, nothing re-syncs',
    expect: { path: '/transactions', params: { demo: '1', q: 'amaz' }, input: 'amaz', demoState: true },
    drive: async (impl) => {
      const staleSP = impl === 'raw' ? G.demoSP : new URLSearchParams(window.location.search)
      const staleSet = G.demoSet
      const staleWrite = G.demoWrite
      await typeAmaz()
      await settle(450)
      mark('stale write, nothing else changes')
      await act(async () => {
        if (impl === 'raw') {
          staleSet(new URLSearchParams(staleSP), { replace: true })
        } else {
          // The helper accepts a patch, not a snapshot. The nearest a caller can come
          // to C2 is converting its stale snapshot into a patch, which can only name
          // keys that existed when the snapshot was taken.
          staleWrite(Object.fromEntries(staleSP))
        }
      })
    },
  },
  {
    id: 'P1', title: 'Budgets-shaped: URL write after an await, URL changes during it',
    budgets: 'save',
    expect: { path: '/transactions', params: { category: 'GROCERIES', month: '2026-09' }, input: '', demoState: false },
    drive: async () => {
      await act(async () => { G.budgetsSave() })
      mark('save started (awaits 200ms)')
      await settle(50)
      mark('category -> GROCERIES during the await')
      await act(async () => { G.setFilter({ category: 'GROCERIES' }) })
      await settle(50)
      mark('exit demo during the await')
      await act(async () => { G.setDemoMode(false) })
    },
  },
  {
    id: 'P1b', title: 'Budgets-shaped: URL write after an await, user navigates away during it',
    budgets: 'save',
    expect: { path: '/accounts', params: { demo: '1' }, demoState: true },
    drive: async () => {
      await act(async () => { G.budgetsSave() })
      mark('save started (awaits 200ms)')
      await settle(50)
      mark('navigate to /accounts during the await')
      await act(async () => { G.navigate('/accounts?demo=1') })
    },
  },
  {
    id: 'P2-deps', title: 'Budgets-shaped: timer effect with the setter omitted from its deps',
    budgets: 'deps',
    expect: { path: '/transactions', params: { category: 'GROCERIES', month: '2026-09' }, input: '', demoState: false },
    drive: async () => {
      await settle(50)
      mark('category -> GROCERIES before the timer fires')
      await act(async () => { G.setFilter({ category: 'GROCERIES' }) })
      await settle(50)
      mark('exit demo before the timer fires')
      await act(async () => { G.setDemoMode(false) })
    },
  },
  {
    id: 'P2-ref', title: 'Budgets-shaped: setter held in a ref, never refreshed',
    budgets: 'ref',
    expect: { path: '/transactions', params: { category: 'GROCERIES', month: '2026-09' }, input: '', demoState: false },
    drive: async () => {
      await settle(50)
      mark('category -> GROCERIES before the timer fires')
      await act(async () => { G.setFilter({ category: 'GROCERIES' }) })
      await settle(50)
      mark('exit demo before the timer fires')
      await act(async () => { G.setDemoMode(false) })
    },
  },
]

// What each implementation must do. `clean` = final state correct, typed input
// never wiped, and no param ever dropped out of the URL after appearing.
// raw outcomes are asserted too: if the raw code stopped exhibiting these
// failures, the scenarios would no longer be proving anything about the helper.
const ASSERT = {
  raw: { '0': 'correct', '0b': 'correct', A: 'correct', B: 'correct', C: 'correct', C2: 'broken', P1: 'broken', P1b: 'broken', 'P2-deps': 'broken', 'P2-ref': 'broken' },
  helper: { '0': 'clean', '0b': 'clean', A: 'clean', B: 'clean', C: 'clean', C2: 'clean', P1: 'clean', P1b: 'clean', 'P2-deps': 'clean', 'P2-ref': 'clean' },
}

const sameParams = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())
const paramsOf = (search) => Object.fromEntries(new URLSearchParams(search))

async function run(scenario, impl) {
  window.history.replaceState(null, '', '/transactions?demo=1')
  G = {}
  log = []
  lastState = null
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  t0 = performance.now()
  await act(async () => { root.render(h(BrowserRouter, null, h(Root, { impl, budgets: scenario.budgets }))) })

  await scenario.drive(impl)
  await settle(800)

  const states = log.filter((e) => !e.mark)

  let sawInput = false
  let wiped = false
  for (const e of states) {
    if (e.input === 'amaz') sawInput = true
    else if (sawInput && e.input === '') wiped = true
  }

  // A non-demo param that appeared on this page and later vanished from it.
  const seen = new Set()
  const lost = new Set()
  for (const e of states) {
    if (e.path !== scenario.expect.path && scenario.expect.path === '/accounts') continue
    const p = new URLSearchParams(e.url === '(none)' ? '' : e.url)
    for (const k of seen) if (k !== DEMO && !p.has(k)) lost.add(k)
    for (const k of p.keys()) seen.add(k)
  }

  const live = {
    path: window.location.pathname,
    params: paramsOf(window.location.search),
    input: G.view ? G.view.input : null,
    demoState: G.demoMode,
  }
  const x = scenario.expect
  const finalCorrect = live.path === x.path && sameParams(live.params, x.params) &&
    live.demoState === x.demoState && (x.input === undefined || live.input === x.input)

  const outcome = finalCorrect && !wiped && lost.size === 0 ? 'clean' : finalCorrect && !wiped ? 'correct' : 'broken'
  const want = ASSERT[impl][scenario.id]
  const pass = want === 'correct' ? outcome === 'correct' || outcome === 'clean' : outcome === want

  if (VERBOSE || !pass) {
    console.log(`\n=== ${impl.padEnd(6)} ${scenario.id}: ${scenario.title} ===`)
    for (const e of log) {
      if (e.mark) { console.log(`  +${String(e.ms).padStart(4)}ms  ---- ${e.mark} ----`); continue }
      console.log(`  +${String(e.ms).padStart(4)}ms  ${e.path.padEnd(13)} url=${e.url.padEnd(34)} input=${JSON.stringify(e.input).padEnd(7)} q=${JSON.stringify(e.effectiveQ).padEnd(7)} demo=${e.demoState}`)
    }
    console.log(`  live final: ${live.path}?${new URLSearchParams(live.params)} input=${JSON.stringify(live.input)} demo=${live.demoState}`)
  }

  await act(async () => { root.unmount() })
  container.remove()
  return { id: scenario.id, impl, finalCorrect, wiped, lost: [...lost], outcome, want, pass }
}

const results = []
for (const impl of ['raw', 'helper']) {
  for (const scenario of SCENARIOS) results.push(await run(scenario, impl))
}

console.log('\nimpl    scenario  final    wiped  lost-params   outcome  asserted  ')
console.log('------  --------  -------  -----  ------------  -------  ----------')
for (const r of results) {
  console.log(
    `${r.impl.padEnd(6)}  ${r.id.padEnd(8)}  ${String(r.finalCorrect).padEnd(7)}  ${String(r.wiped).padEnd(5)}  ` +
    `${(r.lost.join(',') || '-').padEnd(12)}  ${r.outcome.padEnd(7)}  ${r.pass ? 'ok' : `FAIL (want ${r.want})`}`,
  )
}

const failures = results.filter((r) => !r.pass)
console.log(failures.length ? `\n${failures.length} assertion(s) failed.` : '\nAll assertions hold.')
process.exit(failures.length ? 1 : 0)
