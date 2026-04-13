import { useState } from "react"
import { Budget } from "./types"

const API = "https://finance-dashboard-production-1a0c.up.railway.app"

const STATUS_COLORS = {
  on_track: { bar: "#00e87a", text: "#00a856", bg: "rgba(0,232,122,0.07)" },
  warning:  { bar: "#f0a030", text: "#f0a030", bg: "rgba(240,160,48,0.08)" },
  over:     { bar: "#e85555", text: "#e85555", bg: "rgba(232,85,85,0.08)"  },
}

interface Props {
  budget:    Budget
  onUpdated: () => void
}

export default function BudgetCard({ budget, onUpdated }: Props) {
  const [editing,   setEditing]   = useState(false)
  const [limitInput, setLimitInput] = useState(String(budget.monthlyLimit))
  const [saving,    setSaving]    = useState(false)

  const colors = STATUS_COLORS[budget.status]

  async function saveLimit() {
    const val = parseFloat(limitInput)
    if (isNaN(val) || val <= 0) { setEditing(false); return }
    setSaving(true)
    try {
      await fetch(`${API}/budgets`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ category: budget.category, monthlyLimit: val }),
      })
      onUpdated()
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  const pct = Math.min(budget.percentUsed, 100)

  return (
    <div style={{
      background:   "#111710",
      border:       "1px solid #1e2b1e",
      borderRadius: 10,
      padding:      "16px 18px",
      marginBottom: 10,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontWeight: 500, fontSize: 13.5, color: "#d4e8d4" }}>
          {budget.category}
        </span>
        <span style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
          padding: "2px 8px", borderRadius: 4,
          background: colors.bg, color: colors.text,
          border: `1px solid ${colors.bar}33`,
          textTransform: "uppercase", letterSpacing: "0.08em",
        }}>
          {budget.status === "on_track" ? "On Track" : budget.status === "warning" ? "Warning" : "Over Budget"}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ background: "#1e2b1e", borderRadius: 3, height: 5, marginBottom: 10, overflow: "hidden" }}>
        <div style={{
          width:        `${pct}%`,
          height:       "100%",
          background:   colors.bar,
          borderRadius: 3,
          transition:   "width 0.4s ease",
        }} />
      </div>

      {/* Amounts row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: "#5a7a5a" }}>
          ${budget.currentSpend.toFixed(2)} spent
        </span>

        {editing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: "#5a7a5a" }}>limit $</span>
            <input
              autoFocus
              value={limitInput}
              onChange={e => setLimitInput(e.target.value)}
              onBlur={saveLimit}
              onKeyDown={e => e.key === "Enter" && saveLimit()}
              style={{
                width: 72, background: "#161e14", border: "1px solid #253325",
                borderRadius: 4, color: "#d4e8d4", fontFamily: "IBM Plex Mono, monospace",
                fontSize: 11, padding: "2px 6px", outline: "none",
              }}
            />
          </div>
        ) : (
          <button
            onClick={() => { setLimitInput(String(budget.monthlyLimit)); setEditing(true) }}
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
              color: "#5a7a5a", textDecoration: "underline",
            }}
          >
            {saving ? "saving…" : `$${budget.monthlyLimit.toFixed(0)} limit`}
          </button>
        )}
      </div>
    </div>
  )
}