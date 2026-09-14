import { useEffect } from "react"
import { DEMO_PARAM } from "./lib/demoMode"
import { useUrlParams } from "./lib/useUrlParams"

// ─────────────────────────────────────────────────────────────────
//  DemoUrlSync — keeps `?demo=1` truthful, from inside the router.
//
//  Must be rendered inside <BrowserRouter>. Renders nothing.
//
//  lib/demoMode.ts originally wrote the URL with history.replaceState, which
//  React Router does not observe, so the router's location.search stayed stale
//  until the next navigation. Writing through the router fixes that. It does
//  NOT mean the address bar and the router can never disagree: after any write
//  they differ until the next render commits, and every writer has to be
//  correct across that gap.
//
//  The gap is why this writes through useUrlParams. Each write is built from
//  the URL as it is at the moment of writing — not from this render's params —
//  and touches only the `demo` key, so search and filter params written by
//  other components in the same gap are preserved.
//
//  State is authoritative, so the param is re-added after any navigation that
//  dropped it (a plain <Link to="/accounts"> discards the query string) and the
//  nav needs no demo-awareness. Writes replace rather than push, so entering or
//  leaving demo adds no history entry and Back navigates instead of toggling
//  demo.
//
//  LOAD-BEARING: there is a one-render gap. After a navigation that dropped
//  the param, the destination route commits once WITHOUT `demo` in
//  location.search; this effect only puts it back after that render
//  (scripts/url-params-repro/link-nav-check.mjs logs it for every tab). That
//  is harmless today for one reason: nothing decides demo mode from the URL
//  after mount. demoMode is React state, and the URL is read exactly once, by
//  readInitialDemoMode() when App mounts. If anything starts reading `demo`
//  from the URL during render — a route component, a guard, a loader — it
//  will see "not demo" on that first render and could, say, fire a request
//  without X-Demo-Mode or flash the sign-in screen. Read useDemo(), never the
//  URL.
//
//  demoMode state itself stays in App, above <Routes> — only the URL write
//  lives down here.
// ─────────────────────────────────────────────────────────────────

export default function DemoUrlSync({ demoMode }: { demoMode: boolean }) {
  const [searchParams, writeParams] = useUrlParams()
  const inUrl = searchParams.get(DEMO_PARAM) === "1"

  useEffect(() => {
    if (inUrl === demoMode) return
    writeParams({ [DEMO_PARAM]: demoMode ? "1" : null })
  }, [demoMode, inUrl, writeParams])

  return null
}
