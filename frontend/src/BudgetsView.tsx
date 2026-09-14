import { useCallback, useEffect, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import TabPage from "./TabPage"
import BudgetCard from "./BudgetCard"
import AddBudgetRow from "./AddBudgetRow"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { useSyncVersion } from "./SyncProvider"
import type { Budget } from "./types"

// ─────────────────────────────────────────────────────────────────
//  BudgetsView — the Budgets tab.
//
//  Owns the budget list: `budgets` and its reload used to live in App.tsx,
//  where nothing but this section ever read them. They are LIFTED here rather
//  than pushed into the cards, because the list has to have one owner —
//  AddBudgetRow needs the existing categories to filter its dropdown, and every
//  add, edit and delete has to refresh the same list. BudgetCard and
//  AddBudgetRow keep their props; they now come from this view, not App.
//
//  No URL state: none of the save handlers write a URL param, so the
//  post-await hazard useUrlParams defends against does not arise here.
//
//  Re-fetches after every sync (useSyncVersion): spend changes when new
//  transactions arrive. The current list stays on screen while it loads.
// ─────────────────────────────────────────────────────────────────

const muted = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 13,
  color: "#5a7a5a",
} as const

export default function BudgetsView() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const syncVersion = useSyncVersion()

  const [budgets, setBudgets] = useState<Budget[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // reload runs from several places (mount, sync, every card's save/delete);
  // only the most recently started one may write state.
  const requestSeq = useRef(0)

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      const res = await apiFetch(`${API_URL}/budgets`)
      const data = await res.json() as { budgets?: Budget[]; error?: string }
      if (seq !== requestSeq.current) return
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`)
      setBudgets(data.budgets ?? [])
      setError(null)
    } catch (e: any) {
      if (seq === requestSeq.current) setError(`Couldn't load budgets: ${e.message}`)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    // Clear loading on the early return too (the stage 0.5 InsightsDashboard bug).
    if (!demoMode && !isSignedIn) {
      setLoading(false)
      return
    }
    reload()
    // syncVersion is a trigger only: a new value means bank data just changed.
  }, [demoMode, isSignedIn, reload, syncVersion])

  return (
    <TabPage title="Budgets" count="this month">
      {loading ? (
        <div style={muted}>Loading budgets…</div>
      ) : error ? (
        <div style={{ ...muted, color: "#ff6b6b" }}>⚠ {error}</div>
      ) : (
        <>
          {budgets.length === 0 && (
            <div style={{ ...muted, marginBottom: 12 }}>No budgets yet.</div>
          )}
          {budgets.map((b) => (
            <BudgetCard key={b.category} budget={b} onUpdated={reload} onDeleted={reload} />
          ))}
          <AddBudgetRow
            existingCategories={budgets.map((b) => b.category)}
            onAdded={reload}
          />
        </>
      )}
    </TabPage>
  )
}
