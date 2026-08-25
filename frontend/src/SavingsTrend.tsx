import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"

interface CashFlowRow {
  month: string    // YYYY-MM
  income: number
  expenses: number
  net: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

const monthName = (ym: string) => {
  const [y, m] = ym.split("-").map(Number)
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" })
}

export default function SavingsTrend() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [rows, setRows] = useState<CashFlowRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/cashflow?months=6`)
        if (res.ok) {
          const json = await res.json()
          console.log("💰 cashflow raw response:", json)
          const all: CashFlowRow[] = Array.isArray(json)
            ? json
            : (json.cashflow ?? json.cashFlow ?? [])
          console.log("💰 rows extracted:", all.length)
          setRows(all.slice(-6))
        }
      } finally { setLoading(false) }
    })()
  }, [demoMode, isSignedIn, apiFetch])

  if (loading) return <div style={{ color: "#5a7a5a", fontSize: 13 }}>Loading…</div>
  if (rows.length === 0) {
    return (
      <div style={{ color: "#5a7a5a", fontSize: 13 }}>
        No cash flow data yet.
      </div>
    )
  }

  // Current YYYY-MM — we'll label partial-month rows
  const now = new Date()
  const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  const total = rows.reduce((s, r) => s + r.net, 0)
  const avg = Math.round(total / rows.length)
  const avgColor = avg >= 0 ? "#00a856" : "#ff7a6b"

  return (
    <div>
      {rows.map(r => {
        const isCurrent = r.month === currentYM
        const positive = r.net >= 0
        const color = positive ? "#00a856" : "#ff7a6b"
        const sign = positive ? "+" : "−"
        return (
          <div key={r.month} style={{
            display: "flex", justifyContent: "space-between", alignItems: "baseline",
            padding: "10px 0",
            borderBottom: "1px solid #1e2b1e",
            fontSize: 13,
          }}>
            <div>
              <span style={{ color: "#d4e8d4", fontWeight: isCurrent ? 600 : 400 }}>
                {monthName(r.month)}
              </span>
              {isCurrent && (
                <span style={{
                  fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                  color: "#5a7a5a", marginLeft: 8,
                }}>so far</span>
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
        {rows.length}-month avg:{" "}
        <span style={{ color: avgColor, fontWeight: 600 }}>
          {avg >= 0 ? "+" : "−"}{fmt(Math.abs(avg))}/mo
        </span>
      </div>
    </div>
  )
}