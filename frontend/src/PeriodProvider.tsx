import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { readWriteResult } from "./lib/writeResult"
import type { PeriodInfo } from "./types"

// ─────────────────────────────────────────────────────────────────
//  PeriodProvider — the user's money-period start day (M7.2).
//
//  Mounted above <Routes>, alongside SyncProvider and following its pattern:
//  views that group by period add `usePeriod().version` to their fetch
//  effect's dependencies, and re-fetch when the setting changes. The backend
//  reads the stored start day itself, so no view passes it as a parameter —
//  there is one source of truth, and a view can't ask for a different period
//  than the rest of the page shows.
//
//  Unlike SyncProvider, this owns its state: the value lives on the server,
//  and only the Settings dialog changes it. `onChange` lets App re-fetch the
//  data it holds itself (the hero's saved figure).
//
//  Demo mode is fixed at day 1: the demo user's stored value is the default,
//  and the Settings entry isn't offered (writes are refused anyway).
// ─────────────────────────────────────────────────────────────────

interface PeriodState {
  /** 1–28. 1 (calendar months) until the stored value has loaded. */
  startDay: number
  loaded: boolean
  /** Increases after every successful save. Use it as an effect dependency. */
  version: number
  /** Resolves to null on success, or a message saying why nothing changed. */
  save: (startDay: number) => Promise<string | null>
}

const PeriodContext = createContext<PeriodState>({
  startDay: 1,
  loaded: false,
  version: 0,
  save: async () => "Settings are unavailable here.",
})

export function usePeriod(): PeriodState {
  return useContext(PeriodContext)
}

/** "so far · day 5 of 30" for an in-progress period, otherwise null. */
export function periodProgress(period: Pick<PeriodInfo, "inProgress" | "dayOfPeriod" | "daysInPeriod"> | null | undefined): string | null {
  if (!period || !period.inProgress) return null
  return `so far · day ${period.dayOfPeriod} of ${period.daysInPeriod}`
}

export default function PeriodProvider({
  onChange,
  children,
}: {
  onChange?: () => void
  children: ReactNode
}) {
  const { isSignedIn, isLoaded } = useAuth()
  const { demoMode } = useDemo()
  const apiFetch = useApiFetch()
  const enabled = demoMode || (isLoaded && !!isSignedIn)

  const [startDay, setStartDay] = useState(1)
  const [loaded, setLoaded] = useState(false)
  const [version, setVersion] = useState(0)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!enabled) {
      setStartDay(1)
      setLoaded(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/user/settings`)
        const data: any = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok && typeof data?.periodStartDay === "number") setStartDay(data.periodStartDay)
      } catch (e: any) {
        console.error("Settings fetch failed:", e.message)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [enabled, apiFetch])

  const save = useCallback(async (next: number): Promise<string | null> => {
    try {
      const res = await apiFetch(`${API_URL}/user/settings`, {
        method: "PUT",
        // useApiFetch adds auth only; express.json() needs this to parse the body.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodStartDay: next }),
      })
      // Not res.ok alone: a blocked demo write is HTTP 200 { demo: true, ok: false }.
      const result = await readWriteResult(res)
      if (!result.ok) return result.message
      const saved = (result.data as any)?.periodStartDay
      setStartDay(typeof saved === "number" ? saved : next)
      setVersion((v) => v + 1)
      onChangeRef.current?.()
      return null
    } catch (e: any) {
      return `Couldn't save: ${e.message}`
    }
  }, [apiFetch])

  const value = useMemo(
    () => ({ startDay, loaded, version, save }),
    [startDay, loaded, version, save],
  )

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>
}
