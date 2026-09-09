// ─────────────────────────────────────────────────────────────────
//  demoMode.ts — how a visitor enters and keeps demo mode.
//
//  Two sources of truth, deliberately:
//   • `?demo=1` in the URL makes the demo shareable and bookmarkable.
//   • sessionStorage makes it survive a hard refresh, and navigation to a
//     route whose link didn't carry the param.
//
//  This module owns sessionStorage and the FIRST read of the URL only. It
//  deliberately does not write the URL: React Router does not observe a direct
//  history.replaceState, so writing here would leave the router's
//  location.search stale. DemoUrlSync.tsx owns the write, through the router.
//
//  Kept free of React and of any router so it can be called during useState
//  initialisation, before the router has mounted.
// ─────────────────────────────────────────────────────────────────

export const DEMO_PARAM = 'demo'

const STORAGE_KEY = 'ledger.demoMode'

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
  const fromUrl = new URLSearchParams(window.location.search).get(DEMO_PARAM) === '1'
  return fromUrl || safeRead()
}

/** Mirrors demo state into sessionStorage. The URL is DemoUrlSync's job. */
export function persistDemoMode(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(STORAGE_KEY, '1')
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* non-fatal — the URL param still carries the current page */
  }
}
