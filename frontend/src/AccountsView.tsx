import { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import TabPage from "./TabPage"
import AccountCard from "./AccountCard"
import ConnectedBanks from "./ConnectedBanks"
import useMediaQuery from "./useMediaQuery"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { useSyncVersion } from "./SyncProvider"
import type { Account } from "./types"

// ─────────────────────────────────────────────────────────────────
//  AccountsView — the Accounts tab: balances and connected banks.
//
//  Fetches /accounts itself rather than taking App's `accounts` as a prop.
//  App can't give that state up (it still feeds the Overview hero and gates
//  most dashboard sections), and threading it down would keep this tab
//  coupled to App — the thing stage 2 is removing. The cost is a second GET of
//  /accounts when both views have mounted.
//
//  Re-fetches after every sync (useSyncVersion), keeping the current balances
//  on screen while it loads.
// ─────────────────────────────────────────────────────────────────

const sectionTitle = {
  fontFamily: "Fraunces, Georgia, serif",
  fontWeight: 300,
  fontSize: 20,
  color: "#e8f4e8",
  margin: "0 0 16px",
} as const

const muted = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 13,
  color: "#5a7a5a",
} as const

export default function AccountsView() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const syncVersion = useSyncVersion()
  const isMobile = useMediaQuery("(max-width: 640px)")

  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Clear loading on the early return too — otherwise a signed-out visitor
    // would sit on "Loading…" forever (the InsightsDashboard bug from stage 0.5).
    if (!demoMode && !isSignedIn) {
      setLoading(false)
      return
    }
    // A newer run (a sync, or a demo/auth switch) supersedes this one.
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/accounts`)
        const data = await res.json() as { accounts?: Account[]; error?: string }
        if (cancelled) return
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`)
        setAccounts(data.accounts ?? [])
        setError(null)
      } catch (e: any) {
        if (!cancelled) setError(`Couldn't load accounts: ${e.message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [demoMode, isSignedIn, apiFetch, syncVersion])

  const count = loading ? undefined : `${accounts.length} account${accounts.length === 1 ? "" : "s"}`

  return (
    <TabPage title="Accounts" count={count}>
      <section style={{ marginBottom: 40 }}>
        <h2 style={sectionTitle}>Balances</h2>
        {loading ? (
          <div style={muted}>Loading accounts…</div>
        ) : error ? (
          <div style={{ ...muted, color: "#ff6b6b" }}>⚠ {error}</div>
        ) : accounts.length === 0 ? (
          <div style={muted}>No accounts connected yet.</div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 16,
          }}>
            {accounts.map((a) => <AccountCard key={a.plaidAccountId} account={a} />)}
          </div>
        )}
      </section>

      <section>
        <h2 style={sectionTitle}>Connected banks</h2>
        <ConnectedBanks />
      </section>
    </TabPage>
  )
}
