import { useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import type { Budget } from "./types"
import { API_URL } from "./config"

const STATUS_COLORS = {
  on_track: {
    bar: "#00e87a",
    text: "#00a856",
    bg: "rgba(0,232,122,0.07)",
  },
  warning: {
    bar: "#f0a030",
    text: "#f0a030",
    bg: "rgba(240,160,48,0.08)",
  },
  projected_over: {
    bar: "#f0a030",
    text: "#f0a030",
    bg: "rgba(240,160,48,0.08)",
  },
  over: {
    bar: "#e85555",
    text: "#e85555",
    bg: "rgba(232,85,85,0.08)",
  },
} as const

interface Props {
  budget: Budget
  onUpdated: () => void
  onDeleted: () => void
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n)
}

export default function BudgetCard({ budget, onUpdated, onDeleted }: Props) {
  const [editing, setEditing] = useState(false)
  const [limitInput, setLimitInput] = useState(String(budget.monthlyLimit))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { getToken } = useAuth()

  const colors = STATUS_COLORS[budget.status]
  const pct = Math.min(budget.percentUsed, 100)

  const projectedPct =
    budget.projected && budget.monthlyLimit > 0
      ? Math.min((budget.projected / budget.monthlyLimit) * 100, 100)
      : 0

  const showProjection =
    budget.status === "projected_over" && budget.projected !== null

  async function saveLimit() {
    const val = parseFloat(limitInput)
    if (isNaN(val) || val <= 0) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      const token = await getToken()
      await fetch(`${API_URL}/budgets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          category: budget.category,
          monthlyLimit: val,
          month: budget.month,
        }),
      })
      onUpdated()
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  async function deleteBudget() {
    if (!window.confirm(`Remove budget for ${budget.category}?`)) return
    setDeleting(true)
    try {
      const token = await getToken()
      await fetch(`${API_URL}/budgets/${budget.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      })
      onDeleted()
    } finally {
      setDeleting(false)
    }
  }

  const badgeText =
    budget.status === "on_track"
      ? "On Track"
      : budget.status === "warning"
      ? "Warning"
      : budget.status === "projected_over"
      ? "Projected Over"
      : "Over Budget"

  const subText =
    budget.status === "over"
      ? `Over by ${fmt(Math.abs(budget.remaining))}`
      : budget.status === "projected_over" && budget.projected !== null
      ? `Projected: ${fmt(budget.projected)} — over by ${fmt(
          budget.projected - budget.monthlyLimit
        )}`
      : budget.status === "warning"
      ? `Remaining: ${fmt(budget.remaining)}`
      : budget.projected !== null
      ? `On pace: ~${fmt(budget.projected)}`
      : `Remaining: ${fmt(budget.remaining)}`

  return (
    <div style={{
      background: "#111710",
      border: "1px solid #1e2b1e",
      borderRadius: 10,
      padding: "16px 18px",
      marginBottom: 10,
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 10,
      }}>
        <span style={{ fontWeight: 500, fontSize: 13.5, color: "#d4e8d4" }}>
          {budget.category}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 4,
            background: colors.bg,
            color: colors.text,
            border: `1px solid ${colors.bar}33`,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}>
            {badgeText}
          </span>

          <button
            onClick={deleteBudget}
            disabled={deleting}
            title="Remove budget"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "#5a7a5a",
              fontSize: 14,
              lineHeight: 1,
              padding: "2px 4px",
              borderRadius: 4,
              opacity: deleting ? 0.4 : 1,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "#e85555" }}
            onMouseLeave={e => { e.currentTarget.style.color = "#5a7a5a" }}
          >
            ×
          </button>
        </div>
      </div>

      <div style={{
        background: "#1e2b1e",
        borderRadius: 3,
        height: 6,
        marginBottom: 10,
        overflow: "hidden",
        position: "relative",
      }}>
        {showProjection && (
          <div style={{
            position: "absolute",
            top: 0, left: 0,
            width: `${projectedPct}%`,
            height: "100%",
            background:
              "repeating-linear-gradient(45deg, rgba(240,160,48,.45) 0, rgba(240,160,48,.45) 3px, transparent 3px, transparent 6px)",
            borderRadius: 3,
          }} />
        )}

        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: colors.bar,
          borderRadius: 3,
          transition: "width 0.4s ease",
          position: "relative",
        }} />
      </div>

      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <div>
          <div style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 11,
            color: "#8a7a5a",
            marginBottom: 2,
          }}>
            {fmt(budget.currentSpend)} / {fmt(budget.monthlyLimit)}
          </div>
          <div style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 10.5,
            color:
              budget.status === "over"
                ? "#e85555"
                : budget.status === "projected_over"
                ? "#f0a030"
                : "#5a7a5a",
          }}>
            {subText}
          </div>
        </div>

        {editing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 11,
              color: "#5a7a5a",
            }}>
              limit $
            </span>
            <input
              autoFocus
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              onBlur={saveLimit}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveLimit()
                if (e.key === "Escape") setEditing(false)
              }}
              style={{
                width: 72,
                background: "#161e14",
                border: "1px solid #253325",
                borderRadius: 4,
                color: "#d4e8d4",
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 11,
                padding: "2px 6px",
                outline: "none",
              }}
            />
          </div>
        ) : (
          <button
            onClick={() => {
              setLimitInput(String(budget.monthlyLimit))
              setEditing(true)
            }}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 11,
              color: "#5a7a5a",
              textDecoration: "underline",
            }}
          >
            {saving ? "saving…" : `${fmt(budget.monthlyLimit)} limit`}
          </button>
        )}
      </div>
    </div>
  )
}
