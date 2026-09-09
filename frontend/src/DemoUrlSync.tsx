import { useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { DEMO_PARAM } from "./lib/demoMode"

// ─────────────────────────────────────────────────────────────────
//  DemoUrlSync — keeps `?demo=1` truthful, from inside the router.
//
//  Must be rendered inside <BrowserRouter>. Renders nothing.
//
//  Why this exists: lib/demoMode.ts used to write the URL with
//  history.replaceState directly. React Router does not observe that, so its
//  location.search went stale the moment demo mode changed — and anything
//  reading useSearchParams (the Transactions tab's search and filters) would
//  have read a lie. setSearchParams writes THROUGH the router, so the two
//  never disagree.
//
//  `replace: true` keeps the original property that entering or leaving demo
//  adds no history entry, so Back navigates rather than toggling demo mode.
//
//  demoMode state itself stays in App, above <Routes> — only the URL write
//  lives down here.
// ─────────────────────────────────────────────────────────────────

export default function DemoUrlSync({ demoMode }: { demoMode: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()

  useEffect(() => {
    // State is authoritative, so this also re-adds the param after any
    // navigation that dropped it — a plain <Link to="/accounts"> discards the
    // query string, which would otherwise strip demo on every nav click.
    if ((searchParams.get(DEMO_PARAM) === '1') === demoMode) return

    // Copied so other params (search, filters, tags) are preserved untouched.
    const next = new URLSearchParams(searchParams)
    if (demoMode) next.set(DEMO_PARAM, '1')
    else next.delete(DEMO_PARAM)

    setSearchParams(next, { replace: true })
  }, [demoMode, searchParams, setSearchParams])

  return null
}
