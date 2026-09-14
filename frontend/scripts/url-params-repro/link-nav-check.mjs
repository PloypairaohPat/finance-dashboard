// Stage 4 check: does ?demo=1 survive <Link> navigation with no demo-awareness in the nav?
//
// Nav links are built from the REAL src/tabs.ts and point at bare paths, so a click
// drops the query string. DemoUrlSync below is src/DemoUrlSync.tsx verbatim (Node can't
// load .tsx), writing through the REAL src/lib/useUrlParams.ts.
// Usage: node scripts/url-params-repro/link-nav-check.mjs

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/?demo=1',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } = await import('react-router-dom')
const { useUrlParams } = await import('../../src/lib/useUrlParams.ts')
const { TABS } = await import('../../src/tabs.ts')

const { useEffect, useLayoutEffect } = React
const act = React.act
const h = React.createElement
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function settle(ms) {
  const end = performance.now() + ms
  while (performance.now() < end) await act(async () => { await sleep(25) })
}

const G = { renders: [] }
let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const here = () => `${window.location.pathname}${window.location.search}`

// src/DemoUrlSync.tsx
function DemoUrlSync({ demoMode }) {
  const [searchParams, writeParams] = useUrlParams()
  const inUrl = searchParams.get('demo') === '1'
  useEffect(() => {
    if (inUrl === demoMode) return
    writeParams({ demo: demoMode ? '1' : null })
  }, [demoMode, inUrl, writeParams])
  return null
}

// What a route component sees on each committed render.
function Page({ id }) {
  const loc = useLocation()
  useLayoutEffect(() => { G.renders.push({ id, url: `${loc.pathname}${loc.search}` }) })
  return h('main', null, id)
}

function Nav() {
  G.navigate = useNavigate()
  return h('nav', null, TABS.map((t) => h(Link, { key: t.id, to: t.path, 'data-id': t.id }, t.label)))
}

function App({ demoMode }) {
  return h(BrowserRouter, null,
    h(DemoUrlSync, { demoMode }),
    h(Nav),
    h(Routes, null, TABS.map((t) => h(Route, { key: t.id, path: t.path, element: h(Page, { id: t.id }) }))),
  )
}

async function click(id) {
  const a = document.querySelector(`a[data-id="${id}"]`)
  await act(async () => {
    a.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
  await settle(100)
}

// ── 1. Demo mode: every tab keeps ?demo=1 ──────────────────────────
const root = createRoot(document.getElementById('root'))
await act(async () => { root.render(h(App, { demoMode: true })) })
await settle(100)
check('demo: lands on /?demo=1', here() === '/?demo=1', here())

const hrefs = TABS.map((t) => document.querySelector(`a[data-id="${t.id}"]`).getAttribute('href'))
check('nav hrefs carry no query string (nav is not demo-aware)', hrefs.every((x) => !x.includes('?')), hrefs.join(' '))

const order = ['accounts', 'budgets', 'transactions', 'subscriptions', 'overview']
for (const id of order) {
  const tab = TABS.find((t) => t.id === id)
  G.renders = []
  await click(id)
  check(`demo: click ${id} -> ${tab.path}?demo=1`, here() === `${tab.path}?demo=1`, here())
  const bare = G.renders.filter((r) => r.id === id && !r.url.includes('demo=1'))
  console.log(`      renders of ${id}: ${G.renders.filter((r) => r.id === id).map((r) => r.url).join(' , ')}` +
    (bare.length ? `  <- ${bare.length} render(s) without demo=1 before DemoUrlSync re-adds it` : ''))
}

// Back should land on the previous tab WITH demo=1, not on a bare URL.
await act(async () => { G.navigate(-1) })
await settle(150)
check('demo: Back returns to /subscriptions?demo=1', here() === '/subscriptions?demo=1', here())
await act(async () => { G.navigate(-1) })
await settle(150)
check('demo: Back again returns to /transactions?demo=1', here() === '/transactions?demo=1', here())

// Other params on the page are dropped by the Link; demo=1 is not.
await act(async () => { G.navigate('/transactions?q=coffee&demo=1') })
await settle(100)
await click('budgets')
check('demo: /transactions?q=coffee&demo=1 -> Budgets keeps demo, drops q', here() === '/budgets?demo=1', here())

await act(async () => { root.unmount() })

// ── 2. Not in demo: links stay clean ───────────────────────────────
window.history.replaceState(null, '', '/')
const root2 = createRoot(document.getElementById('root'))
await act(async () => { root2.render(h(App, { demoMode: false })) })
await settle(100)
await click('accounts')
check('signed-in: click accounts -> /accounts (no demo)', here() === '/accounts', here())
await act(async () => { root2.unmount() })

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks hold.')
process.exit(failures ? 1 : 0)
