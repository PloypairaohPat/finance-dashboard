// src/RecurringCard.jsx — Recurring subscriptions and income streams
import React, { useState, useEffect } from "react"

const API = "http://localhost:3001"

const fmt = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)

const freqLabel = (f) => ({
  WEEKLY:        "weekly",
  BIWEEKLY:      "every 2 weeks",
  SEMI_MONTHLY:  "twice a month",
  MONTHLY:       "monthly",
  ANNUALLY:      "annually",
}[f] || f?.toLowerCase() || "recurring")

function StreamRow({ stream, type }) {
  const isIncome = type === "inflow"
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 0", borderBottom: "1px solid #1a1a1a",
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "14px", fontWeight: 600, color: "#d0cdc8", marginBottom: "2px" }}>
          {stream.merchantName}
        </div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "#555" }}>
          {freqLabel(stream.frequency)} · last {stream.lastDate}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: "15px", fontWeight: 500,
          color: isIncome ? "#00e5a0" : "#f0ede8",
        }}>
          {isIncome ? "+" : "-"}{fmt(stream.averageAmount)}
        </div>
        {stream.status === "EARLY_DETECTION" && (
          <div style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: "10px",
            color: "#f0a030", marginTop: "2px",
          }}>
            detecting…
          </div>
        )}
      </div>
    </div>
  )
}

export default function RecurringCard() {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    fetch(`${API}/recurring`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setData(d)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div style={{ color: "#5a7a5a", fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px", padding: "20px 0" }}>
      Analysing recurring transactions…
    </div>
  )

  if (error) return (
    <div style={{ color: "#ff5555", fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px" }}>
      ⚠ {error}
    </div>
  )

  if (!data || (data.outflow.length === 0 && data.inflow.length === 0)) return (
    <div style={{ color: "#5a7a5a", fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px" }}>
      No recurring streams detected yet — sync more transaction history first.
    </div>
  )

  return (
    <div>
      {/* Monthly summary bar */}
      <div style={{
        display: "flex", gap: "24px", marginBottom: "28px",
        padding: "16px 20px", background: "#111",
        border: "1px solid #1e1e1e", borderRadius: "10px",
        flexWrap: "wrap", gap: "20px",
      }}>
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "#555", marginBottom: "4px" }}>
            monthly subscriptions
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "22px", fontWeight: 500, color: "#ff6b6b" }}>
            -{fmt(data.monthlyOutflow)}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "#555", marginBottom: "4px" }}>
            recurring streams
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "22px", fontWeight: 500, color: "#f0ede8" }}>
            {data.outflow.length + data.inflow.length}
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}>

        {/* Outflow — subscriptions & bills */}
        {data.outflow.length > 0 && (
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", color: "#555", marginBottom: "12px" }}>
              Subscriptions & bills · {data.outflow.length}
            </div>
            {data.outflow.map((s, i) => (
              <StreamRow key={i} stream={s} type="outflow" />
            ))}
          </div>
        )}

        {/* Inflow — income */}
        {data.inflow.length > 0 && (
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "10px", letterSpacing: ".1em", textTransform: "uppercase", color: "#555", marginBottom: "12px" }}>
              Income streams · {data.inflow.length}
            </div>
            {data.inflow.map((s, i) => (
              <StreamRow key={i} stream={s} type="inflow" />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}