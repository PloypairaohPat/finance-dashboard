import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { readWriteResult } from "./lib/writeResult"
import type { Alert, Severity } from "./types"

// ─────────────────────────────────────────────────────────────────
//  AlertsProvider — the single source of alerts for the whole app.
//
//  Mounted above <Routes>, so the bell and its panel work on every route in
//  both demo and signed-in mode. It replaces three separate readers of
//  GET /alerts (App's count, AlertCenter, and what would have been the bell),
//  which matters beyond tidiness: every GET /alerts runs the backend's alert
//  detectors and upserts rows, and a dismiss in one reader never reached the
//  others.
//
//  `refreshToken` is bumped by App after a successful Sync, so alerts refresh
//  with the rest of App's data without App owning alert state.
// ─────────────────────────────────────────────────────────────────

// Severity is a plain string column, so the backend's `orderBy severity`
// sorts alphabetically (high, low, medium, positive). Sort here instead.
const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, positive: 2, low: 3 }

function sortAlerts(list: Alert[]): Alert[] {
  return [...list].sort((a, b) => {
    const s = (SEV_ORDER[a.severity] ?? SEV_ORDER.low) - (SEV_ORDER[b.severity] ?? SEV_ORDER.low)
    if (s !== 0) return s
    return b.triggeredAt.localeCompare(a.triggeredAt)
  })
}

interface AlertsState {
  /** Active alerts, most important first. */
  alerts: Alert[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  /** Resolves to null on success, or a message saying why nothing changed. */
  dismiss: (id: string) => Promise<string | null>
}

const AlertsContext = createContext<AlertsState | null>(null)

export function useAlerts(): AlertsState {
  const value = useContext(AlertsContext)
  if (!value) throw new Error("useAlerts must be used inside <AlertsProvider>")
  return value
}

export default function AlertsProvider({
  refreshToken,
  children,
}: {
  refreshToken: number
  children: ReactNode
}) {
  const { isSignedIn, isLoaded } = useAuth()
  const { demoMode } = useDemo()
  const apiFetch = useApiFetch()
  const enabled = demoMode || (isLoaded && !!isSignedIn)

  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Only the newest request may write state — a slow response from before a
  // demo/auth switch must not overwrite the list that replaced it.
  const requestSeq = useRef(0)

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      const res = await apiFetch(`${API_URL}/alerts`)
      const data: any = await res.json().catch(() => null)
      if (seq !== requestSeq.current) return
      if (!res.ok || !Array.isArray(data)) {
        throw new Error((data && typeof data.error === "string" && data.error) || `HTTP ${res.status}`)
      }
      setAlerts(sortAlerts(data as Alert[]))
      setError(null)
    } catch (e: any) {
      if (seq !== requestSeq.current) return
      setError(`Couldn't load alerts: ${e.message}`)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    if (!enabled) {
      // Invalidate anything in flight and reset, so the next session starts clean.
      requestSeq.current++
      setAlerts([])
      setError(null)
      setLoading(true)
      return
    }
    reload()
    // refreshToken is a trigger only: a new value means "App just synced".
  }, [enabled, reload, refreshToken])

  const dismiss = useCallback(async (id: string): Promise<string | null> => {
    try {
      const res = await apiFetch(`${API_URL}/alerts/${id}/dismiss`, { method: "POST" })
      // Not res.ok alone: a blocked demo write is HTTP 200 { demo: true, ok: false }.
      const result = await readWriteResult(res)
      if (!result.ok) return result.message
      // Removed only after the server confirmed — no optimistic removal that a
      // failed or demo-blocked write would silently leave in place.
      setAlerts((prev) => prev.filter((a) => a.id !== id))
      return null
    } catch (e: any) {
      return `Couldn't dismiss: ${e.message}`
    }
  }, [apiFetch])

  const value = useMemo(
    () => ({ alerts, loading, error, reload, dismiss }),
    [alerts, loading, error, reload, dismiss],
  )

  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>
}
