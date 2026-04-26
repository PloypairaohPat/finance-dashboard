import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import type { FinancialScore, ScoreComponentKey, ScoreGrade } from "./types"

const GRADE_COLOR: Record<ScoreGrade, string> = {
  excellent: "#00e87a", good: "#00a856", fair: "#f0a030",
  needs_work: "#ff7a6b", at_risk: "#e85555",
}
const GRADE_LABEL: Record<ScoreGrade, string> = {
  excellent: "Excellent", good: "Good", fair: "Fair",
  needs_work: "Needs work", at_risk: "At risk",
}
const COMPONENT_LABEL: Record<ScoreComponentKey, string> = {
  savingsRate: "Savings rate", spendingControl: "Spending control",
  debtLoad: "Debt load", growthTrend: "Growth trend",
}
const COMPONENT_ORDER: ScoreComponentKey[] = [
  "savingsRate", "spendingControl", "debtLoad", "growthTrend",
]

function barColor(value: number): string {
  if (value >= 70) return "#00a856"
  if (value >= 50) return "#f0a030"
  return "#e85555"
}

export default function FinancialScoreCard() {
  const { getToken, isSignedIn } = useAuth()
  const [score, setScore] = useState<FinancialScore | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isSignedIn) return
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/score`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setScore(await res.json())
      } finally { setLoading(false) }
    })()
  }, [isSignedIn, getToken])

  if (loading || !score) return <div style={{ color: "#5a7a5a", fontSize: 13, padding: 20 }}>Loading score…</div>

  const gradeColor = GRADE_COLOR[score.grade]
  // SVG dial math
  const radius = 42, circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - score.total / 100)

  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(0,232,122,0.04) 0%, rgba(74,158,255,0.04) 100%)",
      border: "1px solid #253325", borderRadius: 12, padding: 24,
    }}>
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        {/* Dial */}
        <div style={{ position: "relative", width: 100, height: 100, flexShrink: 0 }}>
          <svg width="100" height="100" viewBox="0 0 100 100" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="50" cy="50" r={radius} fill="none" stroke="#1e2b1e" strokeWidth="8" />
            <circle
              cx="50" cy="50" r={radius} fill="none"
              stroke={gradeColor} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset .6s ease" }}
            />
          </svg>
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
          }}>
            <div style={{
              fontFamily: "Fraunces, Georgia, serif", fontSize: 30,
              fontWeight: 300, color: "#e8f4e8", lineHeight: 1,
            }}>{score.total}</div>
            <div style={{
              fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
              color: gradeColor, textTransform: "uppercase",
              letterSpacing: ".08em", marginTop: 3,
            }}>{GRADE_LABEL[score.grade]}</div>
          </div>
        </div>

        {/* Component breakdown */}
        <div style={{ flex: 1, minWidth: 240 }}>
          {COMPONENT_ORDER.map(key => {
            const c = score.components[key]
            const value = c.value
            return (
              <div key={key} title={c.hint} style={{
                display: "grid",
                gridTemplateColumns: "140px 1fr auto",
                gap: 12, alignItems: "center",
                padding: "5px 0",
              }}>
                <span style={{
                  fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                  color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".04em",
                }}>{COMPONENT_LABEL[key]}</span>
                <div style={{
                  height: 4, background: "#0d1510",
                  borderRadius: 2, overflow: "hidden",
                  border: value === null ? "1px dashed #253325" : "none",
                }}>
                  {value !== null && (
                    <div style={{
                      width: `${value}%`, height: "100%",
                      background: barColor(value), borderRadius: 2,
                      transition: "width .4s",
                    }} />
                  )}
                </div>
                <span style={{
                  fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
                  color: value === null ? "#5a7a5a" : "#d4e8d4",
                  minWidth: 32, textAlign: "right",
                }}>{value === null ? "—" : value}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Hints below */}
      <div style={{ marginTop: 16, borderTop: "1px solid #1e2b1e", paddingTop: 12 }}>
        {COMPONENT_ORDER
          .filter(k => score.components[k].value !== null || score.components[k].dataLimited)
          .map(key => {
            const c = score.components[key]
            return (
              <div key={key} style={{
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5,
                color: "#5a7a5a", padding: "3px 0",
                letterSpacing: ".02em",
              }}>
                <span style={{ color: "#8ab88a" }}>{COMPONENT_LABEL[key]}:</span> {c.hint}
              </div>
            )
          })}
      </div>
    </div>
  )
}