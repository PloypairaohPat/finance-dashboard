import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import type { SubscriptionAnalysis, EnrichedStream, Frequency } from "./types"

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
const fmtInt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

const FREQ_LABEL: Record<Frequency, string> = {
  WEEKLY: "weekly", BIWEEKLY: "biweekly", SEMI_MONTHLY: "semi-monthly",
  MONTHLY: "monthly", ANNUALLY: "annually", UNKNOWN: "—",
}

const card: React.CSSProperties = {
  background: "#161e14", border: "1px solid #253325",
  borderRadius: 10, padding: 20, marginBottom: 20,
}
const cardHead: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  marginBottom: 14,
}
const cardTitle: React.CSSProperties = {
  fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
  fontSize: 16, color: "#e8f4e8",
}
const cardTotal: React.CSSProperties = {
  fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
  color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".06em",
}

function StreamRow({ s }: { s: EnrichedStream }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: 12, padding: "10px 0",
      borderBottom: "1px solid #1e2b1e",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{
          fontSize: 13.5, color: "#d4e8d4",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{s.merchant}</span>
        {s.priceChange && s.priceChange.pctChange > 0 && (
          <span style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
            padding: "2px 6px", borderRadius: 3,
            background: "rgba(232,85,85,.15)", color: "#e85555",
            border: "1px solid rgba(232,85,85,.3)",
            textTransform: "uppercase", letterSpacing: ".06em",
            flexShrink: 0,
          }}>+{s.priceChange.pctChange.toFixed(0)}%</span>
        )}
        {s.isDuplicate && (
          <span style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
            padding: "2px 6px", borderRadius: 3,
            background: "rgba(240,160,48,.15)", color: "#f0a030",
            border: "1px solid rgba(240,160,48,.3)",
            textTransform: "uppercase", letterSpacing: ".06em",
            flexShrink: 0,
          }}>dup</span>
        )}
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{
          fontFamily: "Fraunces, Georgia, serif", fontSize: 14, color: "#e8f4e8",
        }}>{fmt(s.lastAmount)}</div>
        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a",
          marginTop: 2,
        }}>{FREQ_LABEL[s.frequency]}</div>
      </div>
    </div>
  )
}

function UpcomingRow({ s }: { s: EnrichedStream }) {
  const days = s.daysUntilNextCharge ?? 0
  const label = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`
  const urgent = days <= 3
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 12, padding: "8px 0",
      borderBottom: "1px solid #1e2b1e",
      alignItems: "center",
    }}>
      <span style={{
        fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
        padding: "2px 8px", borderRadius: 3,
        background: urgent ? "rgba(232,85,85,.15)" : "rgba(74,158,255,.15)",
        color: urgent ? "#e85555" : "#4a9eff",
        border: `1px solid ${urgent ? "rgba(232,85,85,.3)" : "rgba(74,158,255,.3)"}`,
        textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap",
      }}>{label}</span>
      <span style={{ fontSize: 13, color: "#d4e8d4" }}>{s.merchant}</span>
      <span style={{
        fontFamily: "Fraunces, Georgia, serif", fontSize: 14, color: "#e8f4e8",
      }}>{fmt(s.lastAmount)}</span>
    </div>
  )
}

export default function SubscriptionTracker() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [data, setData] = useState<SubscriptionAnalysis | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/subscriptions`)
        if (res.ok) setData(await res.json())
      } finally { setLoading(false) }
    })()
  }, [demoMode, isSignedIn, apiFetch])

  if (loading || !data) {
    return <div style={{ color: "#5a7a5a", fontSize: 13, padding: 20 }}>Loading subscriptions…</div>
  }

  const { subscriptions, bills, upcoming, alerts, totals } = data

  return (
    <div>
      {/* Alerts at the top — most actionable */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          {alerts.map((a, idx) => {
            const colors = a.kind === "price_up"
              ? { bg: "rgba(232,85,85,.07)", border: "rgba(232,85,85,.2)", left: "#e85555", text: "#c89080" }
              : { bg: "rgba(240,160,48,.07)", border: "rgba(240,160,48,.2)", left: "#f0a030", text: "#c8a060" }
            return (
              <div key={idx} style={{
                background: colors.bg, border: `1px solid ${colors.border}`,
                borderLeft: `3px solid ${colors.left}`, borderRadius: 6,
                padding: "10px 14px", marginBottom: 6, fontSize: 12.5,
                color: colors.text, display: "flex", gap: 10, alignItems: "center",
              }}>
                <span style={{ fontSize: 14 }}>⚠</span>
                <span>{a.message}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Subscriptions */}
      <div style={card}>
        <div style={cardHead}>
          <div style={cardTitle}>Subscriptions</div>
          <div style={cardTotal}>{fmtInt(totals.monthlySubscriptions)}/mo</div>
        </div>
        {subscriptions.length === 0 ? (
          <div style={{ color: "#5a7a5a", fontSize: 13 }}>No subscriptions detected yet.</div>
        ) : subscriptions.map(s => <StreamRow key={s.merchant + s.lastDate} s={s} />)}
      </div>

      {/* Bills */}
      <div style={card}>
        <div style={cardHead}>
          <div style={cardTitle}>Bills</div>
          <div style={cardTotal}>{fmtInt(totals.monthlyBills)}/mo</div>
        </div>
        {bills.length === 0 ? (
          <div style={{ color: "#5a7a5a", fontSize: 13 }}>No bills detected yet.</div>
        ) : bills.map(s => <StreamRow key={s.merchant + s.lastDate} s={s} />)}
      </div>

      {/* Upcoming */}
      <div style={card}>
        <div style={cardHead}>
          <div style={cardTitle}>Upcoming · next 14 days</div>
          <div style={cardTotal}>{upcoming.length} due</div>
        </div>
        {upcoming.length === 0 ? (
          <div style={{ color: "#5a7a5a", fontSize: 13 }}>Nothing due in the next two weeks.</div>
        ) : upcoming.map(s => <UpcomingRow key={s.merchant + s.nextChargeDate} s={s} />)}
      </div>
    </div>
  )
}