import { useCallback, useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import TabPage from "./TabPage"
import BudgetCard from "./BudgetCard"
import AddBudgetRow from "./AddBudgetRow"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
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
//  TODO(M7.1-stage4-sync-refresh): this list is NOT refreshed by App's "Sync"
//  button — its triggerRefresh (src/App.tsx, at the Sync button) only refreshes
//  App's own state, and budgets are no longer part of it. Unreachable while that
//  header lives inside the Overview dashboard; becomes a real stale-data bug
//  when the header moves to app level in M7.1 stage 4. Wire this view into the
//  refresh path then, and remove this TODO along with the others carrying it.
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

  const [budgets, setBudgets] = useState<Budget[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/budgets`)
      const data = await res.json() as { budgets?: Budget[]; error?: string }
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`)
      setBudgets(data.budgets ?? [])
      setError(null)
    } catch (e: any) {
      setError(`Couldn't load budgets: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    // Clear loading on the early return too (the stage 0.5 InsightsDashboard bug).
    if (!demoMode && !isSignedIn) {
      setLoading(false)
      return
    }
    reload()
  }, [demoMode, isSignedIn, reload])

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
