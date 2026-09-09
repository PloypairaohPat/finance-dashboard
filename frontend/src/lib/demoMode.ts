// ─────────────────────────────────────────────────────────────────
//  demoMode.ts — how a visitor enters, keeps, and leaves demo mode.
//
//  Two sources of truth, deliberately:
//   • `?demo=1` in the URL makes the demo shareable and bookmarkable.
//   • sessionStorage makes it survive a hard refresh and, once routing
//     lands, navigation to a route whose link didn't carry the param.
//
//  Kept free of React and of any router so it can move above the router
//  in M7.1 without changing.
// ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ledger.demoMode'
const PARAM = 'demo'

// sessionStorage throws outright in some privacy modes, so every access is
// guarded — losing demo persistence is acceptable, crashing the app is not.
function safeRead(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Initial demo state: an explicit `?demo=1` wins, else a stored session. */
export function readInitialDemoMode(): boolean {
  const fromUrl = new URLSearchParams(window.location.search).get(PARAM) === '1'
  return fromUrl || safeRead()
}

/**
 * Mirrors demo state into sessionStorage and the URL. Uses replaceState so
 * entering or leaving demo never adds a history entry — otherwise Back would
 * toggle demo mode instead of returning to the previous page.
 */
export function persistDemoMode(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(STORAGE_KEY, '1')
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* non-fatal — the URL param still carries the current page */
  }

  const url = new URL(window.location.href)
  if (on) url.searchParams.set(PARAM, '1')
  else url.searchParams.delete(PARAM)

  if (url.toString() !== window.location.href) {
    window.history.replaceState(window.history.state, '', url)
  }
}
