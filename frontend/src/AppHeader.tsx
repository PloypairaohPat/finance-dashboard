import { ReactNode } from "react"
import { useMatch } from "react-router-dom"
import AlertsBell from "./AlertsBell"
import useMediaQuery from "./useMediaQuery"
import { TABS } from "./tabs"

// ─────────────────────────────────────────────────────────────────
//  AppHeader — the app-level header, rendered above <Routes>.
//
//  The word-mark, the alerts bell and the account control (Exit demo or the
//  Clerk user menu) show on every route. `overviewActions` (+ Link Account,
//  Sync, Live Balances) render ONLY on the Overview route: those buttons
//  refresh App's own state, and the other tabs fetch for themselves, so
//  showing Sync there would make the stage 4 stale-data gap reachable (see
//  TODO(M7.1-stage4-sync-refresh) in App.tsx).
//
//  Layout and styling are the old Overview header, unchanged. The responsive
//  nav (top bar / bottom nav) replaces this in stage 4.
// ─────────────────────────────────────────────────────────────────

export default function AppHeader({
  overviewActions,
  accountControl,
}: {
  overviewActions: ReactNode
  accountControl: ReactNode
}) {
  const isMobile = useMediaQuery("(max-width: 640px)")
  const onOverview = useMatch({ path: TABS[0].path, end: true }) !== null

  return (
    <header style={{
      borderBottom: "1px solid #222",
      padding: isMobile ? "16px 20px" : "24px 40px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: "#0d0d0d",
      gap: 12,
      flexWrap: "wrap",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{
          fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
          fontSize: 22, color: "#e8f4e8", letterSpacing: "-.01em",
        }}>Ledger</span>
        <span style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 10,
          color: "#5a7a5a", letterSpacing: ".06em",
        }}>v0.5</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        {onOverview && overviewActions}
        <AlertsBell />
        {accountControl}
      </div>
    </header>
  )
}
