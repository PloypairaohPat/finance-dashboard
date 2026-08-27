import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import type { Alert, Severity } from "./types"
import { SkeletonList } from "./Skeleton"

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, positive: 2, low: 3 }
const SEV_STYLE: Record<Severity, { bg: string; border: string; left: string; text: string; icon: string }> = {
  high:     { bg: "rgba(232,85,85,.07)",  border: "rgba(232,85,85,.2)",   left: "#e85555", text: "#c89080", icon: "⚠" },
  medium:   { bg: "rgba(240,160,48,.07)", border: "rgba(240,160,48,.2)",  left: "#f0a030", text: "#c8a060", icon: "▲" },
  low:      { bg: "rgba(74,158,255,.07)", border: "rgba(74,158,255,.15)", left: "#4a9eff", text: "#7898c8", icon: "ⓘ" },
  positive: { bg: "rgba(0,232,122,.07)",  border: "rgba(0,232,122,.15)",  left: "#00a856", text: "#6aaa88", icon: "✓" },
}

const COLLAPSED_COUNT = 2

export default function AlertCenter() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/alerts`)
        if (res.ok) {
          const data: Alert[] = await res.json()
          // Sort by severity, then triggeredAt desc
          data.sort((a, b) => {
            const s = (SEV_ORDER[a.severity] ?? SEV_ORDER.low) - (SEV_ORDER[b.severity] ?? SEV_ORDER.low)
            if (s !== 0) return s
            return b.triggeredAt.localeCompare(a.triggeredAt)
          })
          setAlerts(data)
        }
      } finally { setLoading(false) }
    })()
  }, [demoMode, isSignedIn, apiFetch])

  const dismiss = async (id: string) => {
    // Optimistic update
    setAlerts(prev => prev.filter(a => a.id !== id))
    await apiFetch(`${API_URL}/alerts/${id}/dismiss`, { method: "POST" }).catch(() => {
      // Rollback on failure — re-fetch
      // For v1 we silently accept; at scale, surface an error toast
    })
  }

  if (loading) return <SkeletonList rows={2} />

  if (alerts.length === 0) {
    return (
      <div style={{
        color: "#5a7a5a", fontSize: 13, padding: 16,
        border: "1px dashed #253325", borderRadius: 8,
        textAlign: "center",
        fontFamily: "IBM Plex Mono, monospace", letterSpacing: ".04em",
      }}>
        Nothing needs attention.
      </div>
    )
  }

  const visible = expanded ? alerts : alerts.slice(0, COLLAPSED_COUNT)
  const hidden = alerts.length - visible.length

  return (
    <div>
      {visible.map(a => {
        const style = SEV_STYLE[a.severity] ?? SEV_STYLE.low
        return (
          <div key={a.id} className="interactive-row" style={{
            background: style.bg, border: `1px solid ${style.border}`,
            borderLeft: `3px solid ${style.left}`, borderRadius: 6,
            padding: "12px 14px", marginBottom: 8,
            fontSize: 13, color: style.text,
            display: "flex", gap: 12, alignItems: "flex-start",
          }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>{style.icon}</span>
            <div style={{ flex: 1, lineHeight: 1.55 }}>
              <strong style={{ color: "#e8f4e8", fontWeight: 500 }}>{a.title}</strong>
              {a.body && (
                <div style={{ marginTop: 3, fontSize: 12.5 }}>{a.body}</div>
              )}
            </div>
            <button onClick={() => dismiss(a.id)} style={{
              background: "transparent", border: "none",
              color: "inherit", opacity: .5, cursor: "pointer",
              fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
              letterSpacing: ".04em", textTransform: "lowercase",
              padding: "2px 4px",
            }} onMouseEnter={e => { e.currentTarget.style.opacity = "1" }}
               onMouseLeave={e => { e.currentTarget.style.opacity = ".5" }}>
              dismiss
            </button>
          </div>
        )
      })}

      {hidden > 0 && (
        <button onClick={() => setExpanded(true)} style={{
          background: "transparent", border: "1px dashed #253325",
          color: "#5a7a5a", width: "100%",
          padding: "8px 12px", borderRadius: 6, cursor: "pointer",
          fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
          letterSpacing: ".04em",
        }}>
          Show {hidden} more
        </button>
      )}
      {expanded && alerts.length > COLLAPSED_COUNT && (
        <button onClick={() => setExpanded(false)} style={{
          background: "transparent", border: "1px dashed #253325",
          color: "#5a7a5a", width: "100%",
          padding: "8px 12px", borderRadius: 6, cursor: "pointer",
          fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
          letterSpacing: ".04em",
        }}>
          Show less
        </button>
      )}
    </div>
  )
}
