import { useState } from "react"
import { Alert } from "./types"

const TYPE_CONFIG = {
  budget_exceeded:   { icon: "⚠", color: "#e85555", bg: "rgba(232,85,85,0.07)",  border: "rgba(232,85,85,0.25)"  },
  monthly_pace:      { icon: "📈", color: "#f0a030", bg: "rgba(240,160,48,0.07)", border: "rgba(240,160,48,0.25)" },
  large_transaction: { icon: "💸", color: "#f0a030", bg: "rgba(240,160,48,0.07)", border: "rgba(240,160,48,0.25)" },
  new_merchant:      { icon: "🏪", color: "#4a9eff", bg: "rgba(74,158,255,0.07)", border: "rgba(74,158,255,0.25)" },
}

interface Props {
  alerts: Alert[]
}

export default function AlertBanner({ alerts }: Props) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())

  const visible = alerts.filter((_, i) => !dismissed.has(i))
  if (visible.length === 0) return null

  function dismiss(index: number) {
    setDismissed(prev => new Set([...prev, index]))
  }

  return (
    <div style={{ marginBottom: 8 }}>
      {alerts.map((alert, i) => {
        if (dismissed.has(i)) return null
        const cfg = TYPE_CONFIG[alert.type]
        return (
          <div key={i} style={{
            display:      "flex",
            alignItems:   "flex-start",
            gap:          14,
            background:   cfg.bg,
            border:       `1px solid ${cfg.border}`,
            borderLeft:   `3px solid ${cfg.color}`,
            borderRadius: "0 8px 8px 0",
            padding:      "12px 16px",
            marginBottom: 8,
          }}>
            <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{cfg.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 11, fontWeight: 600,
                color: cfg.color, marginBottom: 3,
                textTransform: "uppercase", letterSpacing: "0.08em",
              }}>
                {alert.title}
                {alert.amount && (
                  <span style={{ marginLeft: 8, fontWeight: 400 }}>
                    ${alert.amount.toFixed(2)}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: "#8ab88a", lineHeight: 1.5 }}>
                {alert.description}
              </div>
            </div>
            <button
              onClick={() => dismiss(i)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "#5a7a5a", fontSize: 16, flexShrink: 0,
                padding: "0 4px", lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}