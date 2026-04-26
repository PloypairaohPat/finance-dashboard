import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import type { WeeklyDigest } from "./types"

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
const fmtRangeShort = (startISO: string, endISO: string) => {
  const s = new Date(startISO + "T00:00:00"), e = new Date(endISO + "T00:00:00")
  const m = (d: Date) => d.toLocaleDateString("en-US", { month: "short" })
  if (s.getMonth() === e.getMonth()) return `${m(s)} ${s.getDate()}–${e.getDate()}`
  return `${m(s)} ${s.getDate()} – ${m(e)} ${e.getDate()}`
}

export default function WeeklyDigestCard() {
  const { getToken, isSignedIn } = useAuth()
  const [digest, setDigest] = useState<WeeklyDigest | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isSignedIn) return
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/alerts/digest`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setDigest(await res.json())
      } finally { setLoading(false) }
    })()
  }, [isSignedIn, getToken])

  if (loading || !digest) return null       // silent if not ready — fine at top of page

  const savedColor = digest.netSaved >= 0 ? "#00a856" : "#ff7a6b"
  const savedSign = digest.netSaved >= 0 ? "+" : "−"

  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(255,122,107,0.06) 0%, rgba(74,158,255,0.04) 100%)",
      border: "1px solid #253325",
      borderRadius: 12,
      padding: 20,
      marginBottom: 24,
    }}>
      <div style={{
        fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 18,
        color: "#e8f4e8", marginBottom: 14,
      }}>
        This week · {fmtRangeShort(digest.weekStart, digest.weekEnd)}
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12,
        marginBottom: 12,
      }} className="digest-stats-grid">
        <div style={{
          background: "rgba(10,15,12,.6)", border: "1px solid #1e2b1e",
          borderRadius: 6, padding: "10px 12px",
        }}>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9, color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 3 }}>Spent</div>
          <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16, color: "#e8f4e8" }}>{fmt(digest.spent)}</div>
        </div>
        <div style={{
          background: "rgba(10,15,12,.6)", border: "1px solid #1e2b1e",
          borderRadius: 6, padding: "10px 12px",
        }}>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9, color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 3 }}>Saved</div>
          <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16, color: savedColor }}>
            {savedSign}{fmt(Math.abs(digest.netSaved))}
          </div>
        </div>
        <div style={{
          background: "rgba(10,15,12,.6)", border: "1px solid #1e2b1e",
          borderRadius: 6, padding: "10px 12px",
        }}>
          <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9, color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 3 }}>Alerts</div>
          <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16, color: "#e8f4e8" }}>
            {digest.newAlertCount} new
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: "#8ab88a", lineHeight: 1.6 }}>
        {digest.summary}
      </div>
    </div>
  )
}