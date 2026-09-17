import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { useSyncVersion } from "./SyncProvider"
import { periodProgress, useSettings } from "./SettingsProvider"
import type { PeriodInfo } from "./types"

// Net saved per money period (M7.2), from the same /cashflow data as the Cash
// flow chart. Empty periods are listed as $0, not skipped. The current period
// is marked "so far · day X of Y" rather than projected.
interface CashFlowRow extends PeriodInfo {
  month: string
  income: number
  expenses: number
  net: number
  txCount: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export default function SavingsTrend() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [rows, setRows] = useState<CashFlowRow[]>([])
  const [loading, setLoading] = useState(true)
  const syncVersion = useSyncVersion()
  const { version: settingsVersion } = useSettings()

  // Re-runs after every sync and every period-setting change; the current rows
  // stay on screen meanwhile, and a superseded run's response is ignored.
  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/cashflow?months=6`)
        if (res.ok) {
          const json = await res.json()
          const all: CashFlowRow[] = Array.isArray(json)
            ? json
            : (json.cashflow ?? json.cashFlow ?? [])
          if (!cancelled) setRows(all.slice(-6))
        }
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [demoMode, isSignedIn, apiFetch, syncVersion, settingsVersion])

  if (loading) return <div style={{ color: "#5a7a5a", fontSize: 13 }}>Loading…</div>
  if (rows.length === 0 || rows.every(r => r.txCount === 0)) {
    return (
      <div style={{ color: "#5a7a5a", fontSize: 13 }}>
        No cash flow data yet.
      </div>
    )
  }

  const noun = rows[rows.length - 1].startDay === 1 ? "month" : "period"
  const total = rows.reduce((s, r) => s + r.net, 0)
  const avg = Math.round(total / rows.length)
  const avgColor = avg >= 0 ? "#00a856" : "#ff7a6b"

  return (
    <div>
      {rows.map(r => {
        const progress = periodProgress(r)
        const positive = r.net >= 0
        const color = positive ? "#00a856" : "#ff7a6b"
        const sign = positive ? "+" : "−"
        return (
          <div key={r.key} style={{
            display: "flex", justifyContent: "space-between", alignItems: "baseline",
            padding: "10px 0",
            borderBottom: "1px solid #1e2b1e",
            fontSize: 13,
          }}>
            <div>
              <span style={{ color: "#d4e8d4", fontWeight: r.inProgress ? 600 : 400 }}>
                {r.longLabel}
              </span>
              {progress && (
                <span style={{
                  fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                  color: "#5a7a5a", marginLeft: 8,
                }}>{progress}</span>
              )}
            </div>
            <span style={{
              fontFamily: "Fraunces, Georgia, serif", fontSize: 14, color,
            }}>
              {sign}{fmt(Math.abs(r.net))}
            </span>
          </div>
        )
      })}
      <div style={{
        marginTop: 14, paddingTop: 12,
        borderTop: "1px solid #253325",
        textAlign: "center",
        fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a",
        letterSpacing: ".04em",
      }}>
        {rows.length}-{noun} avg:{" "}
        <span style={{ color: avgColor, fontWeight: 600 }}>
          {avg >= 0 ? "+" : "−"}{fmt(Math.abs(avg))}/{noun === "month" ? "mo" : "period"}
        </span>
      </div>
    </div>
  )
}
