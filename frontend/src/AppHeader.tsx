import { ReactNode } from "react"
import { useMatch } from "react-router-dom"
import AlertsBell from "./AlertsBell"
import AppNav from "./AppNav"
import useMediaQuery from "./useMediaQuery"
import { TABS } from "./tabs"

// ─────────────────────────────────────────────────────────────────
//  AppHeader — the app-level header and nav, rendered above <Routes>.
//
//  On every route: the word-mark, `syncActions` (Sync, Live Balances), the
//  alerts bell, the account control (Exit demo or the Clerk user menu), and
//  AppNav (a tab bar under the header on desktop, a bottom bar on mobile).
//
//  Sync can show everywhere because every view that shows synced data
//  re-fetches when it runs (SyncProvider). `overviewActions` (+ Link Account)
//  stays on the Overview route: it reveals the connect panel, which only
//  exists there.
// ─────────────────────────────────────────────────────────────────

export default function AppHeader({
  overviewActions,
  syncActions,
  accountControl,
}: {
  overviewActions: ReactNode
  syncActions: ReactNode
  accountControl: ReactNode
}) {
  const isMobile = useMediaQuery("(max-width: 640px)")
  const onOverview = useMatch({ path: TABS[0].path, end: true }) !== null

  return (
    <>
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
          {syncActions}
          <AlertsBell />
          {accountControl}
        </div>
      </header>
      <AppNav />
    </>
  )
}
