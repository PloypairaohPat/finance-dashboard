import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"

interface MonthData {
  month: string
  total: number
  categories: Record<string, number>
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export default function CategoryComparison() {
  const { getToken, isSignedIn } = useAuth()
  const [data, setData] = useState<MonthData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isSignedIn) return
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/categories/comparison?months=3`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setData(await res.json())
      } finally {
        setLoading(false)
      }
    })()
  }, [isSignedIn, getToken])

  if (loading) return <div style={{ color: "#5a7a5a", fontSize: 13 }}>Loading…</div>
  if (data.length < 2) {
    return (
      <div style={{ color: "#5a7a5a", fontSize: 13 }}>
        Need at least 2 months of data for comparison.
      </div>
    )
  }

  const current  = data[data.length - 1]
  const previous = data[data.length - 2]

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
        letterSpacing: ".08em", marginBottom: 14,
      }}>
        vs. last month
      </div>

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
