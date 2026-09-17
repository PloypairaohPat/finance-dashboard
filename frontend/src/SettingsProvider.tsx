import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { readWriteResult } from "./lib/writeResult"
import type { PeriodInfo } from "./types"

// ─────────────────────────────────────────────────────────────────
//  SettingsProvider — the user's own settings (M7.2 period start day, M7.3
//  payment-app inflows as income).
//
//  Mounted above <Routes>, alongside SyncProvider and following its pattern:
//  views that group by period add `useSettings().version` to their fetch
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

export interface UserSettings {
  /** 1–28. 1 (calendar months) until the stored value has loaded. */
  startDay: number
  /**
   * Money in through a payment app counts as income rather than netting
   * against payments to people. Off until the stored value has loaded, which
   * is also the default for a user who has never set it.
   */
  paymentAppInflowsAreIncome: boolean
}

interface SettingsState extends UserSettings {
  loaded: boolean
  /** Increases after every successful save. Use it as an effect dependency. */
  version: number
  /**
   * Save one setting or both; anything left out is untouched.
   * Resolves to null on success, or a message saying why nothing changed.
   */
  save: (patch: Partial<UserSettings>) => Promise<string | null>
}

const DEFAULTS: UserSettings = { startDay: 1, paymentAppInflowsAreIncome: false }

const SettingsContext = createContext<SettingsState>({
  ...DEFAULTS,
  loaded: false,
  version: 0,
  save: async () => "Settings are unavailable here.",
})

export function useSettings(): SettingsState {
  return useContext(SettingsContext)
}

/** "so far · day 5 of 30" for an in-progress period, otherwise null. */
export function periodProgress(period: Pick<PeriodInfo, "inProgress" | "dayOfPeriod" | "daysInPeriod"> | null | undefined): string | null {
  if (!period || !period.inProgress) return null
  return `so far · day ${period.dayOfPeriod} of ${period.daysInPeriod}`
}

export default function SettingsProvider({
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

  const [settings, setSettings] = useState<UserSettings>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [version, setVersion] = useState(0)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!enabled) {
      setSettings(DEFAULTS)
      setLoaded(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/user/settings`)
        const data: any = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok) {
          setSettings({
            startDay: typeof data?.periodStartDay === "number" ? data.periodStartDay : DEFAULTS.startDay,
            paymentAppInflowsAreIncome: data?.paymentAppInflowsAreIncome === true,
          })
        }
      } catch (e: any) {
        console.error("Settings fetch failed:", e.message)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [enabled, apiFetch])

  const save = useCallback(async (patch: Partial<UserSettings>): Promise<string | null> => {
    try {
      const res = await apiFetch(`${API_URL}/user/settings`, {
        method: "PUT",
        // useApiFetch adds auth only; express.json() needs this to parse the body.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(patch.startDay !== undefined && { periodStartDay: patch.startDay }),
          ...(patch.paymentAppInflowsAreIncome !== undefined && {
            paymentAppInflowsAreIncome: patch.paymentAppInflowsAreIncome,
          }),
        }),
      })
      // Not res.ok alone: a blocked demo write is HTTP 200 { demo: true, ok: false }.
      const result = await readWriteResult(res)
      if (!result.ok) return result.message
      // The server answers with both settings as stored, so what the UI shows
      // next is what was saved, not what was asked for.
      const saved = result.data as any
      setSettings((prev) => ({
        startDay: typeof saved?.periodStartDay === "number" ? saved.periodStartDay : patch.startDay ?? prev.startDay,
        paymentAppInflowsAreIncome:
          typeof saved?.paymentAppInflowsAreIncome === "boolean"
            ? saved.paymentAppInflowsAreIncome
            : patch.paymentAppInflowsAreIncome ?? prev.paymentAppInflowsAreIncome,
      }))
      setVersion((v) => v + 1)
      onChangeRef.current?.()
      return null
    } catch (e: any) {
      return `Couldn't save: ${e.message}`
    }
  }, [apiFetch])

  const value = useMemo(
    () => ({ ...settings, loaded, version, save }),
    [settings, loaded, version, save],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
