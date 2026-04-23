import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import type { InsightsResponse, Sentiment } from "./types"
import TopMerchants from "./TopMerchants"
import LargestPurchases from "./LargestPurchases"

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

const SENT_COLOR: Record<Sentiment, string> = {
  positive: "#00a856",
  negative: "#ff7a6b",
  neutral: "#5a7a5a",
}
const SENT_ICON: Record<Sentiment, string> = {
  positive: "↓",
  negative: "↑",
  neutral: "·",
}

const card: React.CSSProperties = {
  background: "#161e14", border: "1px solid #253325",
  borderRadius: 10, padding: 20,
}
const cardTitle: React.CSSProperties = {
  fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
  fontSize: 16, color: "#e8f4e8", marginBottom: 14,
}
const statBox: React.CSSProperties = {
  background: "#0d1510", border: "1px solid #1e2b1e",
  borderRadius: 6, padding: "10px 12px",
}
const statLabel: React.CSSProperties = {
  fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
  color: "#5a7a5a", textTransform: "uppercase",
  letterSpacing: ".08em", marginBottom: 4,
}
const statValue: React.CSSProperties = {
  fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 20,
}

export default function InsightsDashboard() {
  const { getToken, isSignedIn } = useAuth()
  const [data, setData] = useState<InsightsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isSignedIn) return
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/insights`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setData(await res.json())
      } finally { setLoading(false) }
    })()
  }, [isSignedIn, getToken])

  if (loading || !data) {
    return <div style={{ color: "#5a7a5a", fontSize: 13, padding: 20 }}>Loading insights…</div>
  }

  const { summary, runway, highlights } = data
  const netColor = summary.netSaved >= 0 ? "#00a856" : "#ff7a6b"

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {/* Row 1: Summary + Runway */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }} className="insights-row">
        <div style={card}>
          <div style={cardTitle}>Monthly summary · {summary.monthLabel}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={statBox}>
              <div style={statLabel}>Income</div>
              <div style={{ ...statValue, color: "#00a856" }}>{fmt(summary.income)}</div>
            </div>
            <div style={statBox}>
              <div style={statLabel}>Expenses</div>
              <div style={{ ...statValue, color: "#ff7a6b" }}>{fmt(summary.expenses)}</div>
            </div>
            <div style={statBox}>
              <div style={statLabel}>Net Saved</div>
              <div style={{ ...statValue, color: netColor }}>{fmt(summary.netSaved)}</div>
            </div>
            <div style={statBox}>
              <div style={statLabel}>Savings Rate</div>
              <div style={statValue}>
                {summary.savingsRate === null ? "—" : `${summary.savingsRate}%`}
              </div>
            </div>
          </div>
        </div>

        <div style={card}>
          <div style={cardTitle}>Cash runway</div>
          {runway.months === null ? (
            <div>
              <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 28, color: "#5a7a5a", fontWeight: 300 }}>—</div>
              <div style={{ fontSize: 12, color: "#5a7a5a", marginTop: 8 }}>
                Need at least 30 days of expense data.
              </div>
            </div>
          ) : (
            <div>
              <div style={{
                fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
                fontSize: 32, color: "#e8f4e8", lineHeight: 1.1,
              }}>{runway.months} months</div>
              <div style={{
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                color: "#5a7a5a", marginTop: 6,
                textTransform: "uppercase", letterSpacing: ".08em",
              }}>
                {fmt(runway.cashAvailable)} cash · {fmt(runway.avgMonthlyExpenses)}/mo avg
              </div>
              <div style={{ fontSize: 12, color: "#8ab88a", marginTop: 14, lineHeight: 1.5 }}>
                {runway.months >= 6
                  ? "If income stopped tomorrow, your cash would last well past the 6-month rule of thumb."
                  : runway.months >= 3
                  ? "If income stopped tomorrow, you'd have a 3–6 month buffer to react."
                  : "Cash buffer is below the 3-month rule of thumb. Consider building it up."}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Highlights + Top Merchants */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }} className="insights-row">
        <div style={card}>
          <div style={cardTitle}>This month · insights</div>
          {highlights.length === 0 ? (
            <div style={{ color: "#5a7a5a", fontSize: 13 }}>
              Not enough data for insights yet — check back after a full month.
            </div>
          ) : highlights.map((h, idx) => (
            <div key={idx} style={{
              display: "flex", gap: 10, padding: "10px 0",
              borderBottom: idx < highlights.length - 1 ? "1px solid #1e2b1e" : "none",
              alignItems: "flex-start",
            }}>
              <span style={{
                fontFamily: "IBM Plex Mono, monospace",
                color: SENT_COLOR[h.sentiment], width: 14, flexShrink: 0,
              }}>{SENT_ICON[h.sentiment]}</span>
              <span style={{ fontSize: 12.5, color: "#d4e8d4", lineHeight: 1.55 }}>
                {h.headline}
              </span>
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={cardTitle}>Top merchants · {summary.monthLabel}</div>
          <TopMerchants merchants={data.topMerchants} />
        </div>
      </div>

      {/* Row 3: Largest purchases (full width) */}
      <div style={card}>
        <div style={cardTitle}>Largest purchases · {summary.monthLabel}</div>
        <LargestPurchases purchases={data.largestPurchases} />
      </div>
    </div>
  )
}