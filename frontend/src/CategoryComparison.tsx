import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { useSyncVersion } from "./SyncProvider"
import { periodProgress, useSettings } from "./SettingsProvider"
import { SkeletonList } from "./Skeleton"
import type { PeriodInfo } from "./types"

// Category spend, current money period vs the previous one (M7.2). The current
// period is usually in progress, so the header says "so far · day X of Y": a
// category that looks "down" may only be down because the period isn't over.
interface PeriodCategories extends PeriodInfo {
  month: string
  total: number
  categories: Record<string, number>
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export default function CategoryComparison() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [data, setData] = useState<PeriodCategories[]>([])
  const [loading, setLoading] = useState(true)
  const syncVersion = useSyncVersion()
  const { version: settingsVersion } = useSettings()

  // Re-runs after every sync and every period-setting change; the current data
  // stays on screen meanwhile, and a superseded run's response is ignored.
  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/categories/comparison?months=3`)
        if (res.ok) {
          const json = await res.json()
          if (!cancelled) setData(json)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [demoMode, isSignedIn, apiFetch, syncVersion, settingsVersion])

  if (loading) return <SkeletonList rows={4} />

  const noun = data.length > 0 && data[data.length - 1].startDay !== 1 ? "period" : "month"

  if (data.length < 2) {
    return (
      <div style={{ color: "#5a7a5a", fontSize: 13 }}>
        Need a full {noun} for comparison.
      </div>
    )
  }

  const current  = data[data.length - 1]
  const previous = data[data.length - 2]
  const progress = periodProgress(current)

  const rows = Object.entries(current.categories)
    .map(([category, amount]) => {
      const prev     = previous.categories[category] ?? 0
      const delta    = amount - prev
      const deltaPct = prev > 0 ? (delta / prev) * 100 : null
      return { category, amount, prev, delta, deltaPct }
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6)

  return (
    <div>
      <div style={{
        fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
        color: "#5a7a5a", textTransform: "uppercase",
        letterSpacing: ".08em", marginBottom: progress ? 4 : 14,
      }}>
        vs. last {noun}
      </div>
      {progress && (
        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
          color: "#f0a030", letterSpacing: ".04em", marginBottom: 14,
        }}>
          {current.label} · {progress}
        </div>
      )}

      {rows.map(r => {
        const up    = r.delta > 0
        const color = up ? "#ff7a6b" : "#00a856"
        const sign  = up ? "+" : ""
        return (
          <div key={r.category} style={{
            display: "flex", justifyContent: "space-between",
            alignItems: "baseline", padding: "10px 0",
            borderBottom: "1px solid #1e2b1e",
          }}>
            <div>
              <div style={{ fontSize: 13.5, color: "#d4e8d4" }}>{r.category}</div>
              <div style={{
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 10.5, color: "#5a7a5a", marginTop: 2,
              }}>
                was {fmt(r.prev)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{
                fontFamily: "Fraunces, Georgia, serif",
                fontSize: 15, color: "#e8f4e8",
              }}>{fmt(r.amount)}</div>
              <div style={{
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 10.5, color, marginTop: 2,
              }}>
                {r.deltaPct === null
                  ? "new"
                  : `${sign}${r.deltaPct.toFixed(0)}%`}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
