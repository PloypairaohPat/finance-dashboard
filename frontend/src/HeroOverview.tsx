import React from "react"

export interface HeroOverviewProps {
  netWorth: number | null
  netWorthMomPct: number | null
  cashAvailable: number | null
  debt: number | null
  monthSaved: number | null
  monthLabel: string
  lastSyncAt: string | null
}

const fmtCurrency = (n: number | null): string => {
  if (n === null || Number.isNaN(n)) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n)
}

const fmtRelative = (iso: string | null): string => {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)

  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`

  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`

  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const card: React.CSSProperties = {
  background: "#161e14",
  border: "1px solid #253325",
  borderRadius: 10,
  padding: "16px 18px",
  minHeight: 92,
}

const label: React.CSSProperties = {
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 10,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: "#5a7a5a",
  marginBottom: 8,
}

const value: React.CSSProperties = {
  fontFamily: "Fraunces, Georgia, serif",
  fontWeight: 300,
  fontSize: 24,
  lineHeight: 1.1,
  color: "#e8f4e8",
}

const sub: React.CSSProperties = {
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 10,
  color: "#5a7a5a",
  marginTop: 6,
}

export default function HeroOverview(props: HeroOverviewProps) {
  const {
    netWorth,
    netWorthMomPct,
    cashAvailable,
    debt,
    monthSaved,
    monthLabel,
    lastSyncAt,
  } = props

  const momText =
    netWorthMomPct === null
      ? "—"
      : `${netWorthMomPct >= 0 ? "+" : ""}${netWorthMomPct.toFixed(1)}% MoM`

  const momColor = (netWorthMomPct ?? 0) >= 0 ? "#00a856" : "#ff7a6b"
  const savedColor = (monthSaved ?? 0) >= 0 ? "#00a856" : "#ff7a6b"

  return (
    <section
      aria-label="Financial snapshot"
      className="hero-overview"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(5, 1fr)",
        gap: 12,
        marginBottom: 28,
      }}
    >
      <div style={card}>
        <div style={label}>Net Worth</div>
        <div style={value}>{fmtCurrency(netWorth)}</div>
        <div style={{ ...sub, color: momColor }}>{momText}</div>
      </div>

      <div style={card}>
        <div style={label}>Cash Available</div>
        <div style={value}>{fmtCurrency(cashAvailable)}</div>
        <div style={sub}>savings + checking</div>
      </div>

      <div style={card}>
        <div style={label}>Debt</div>
        <div style={{ ...value, color: (debt ?? 0) > 0 ? "#ff7a6b" : "#e8f4e8" }}>
          {fmtCurrency(debt)}
        </div>
        <div style={sub}>credit + loans</div>
      </div>

      <div style={card}>
        <div style={label}>Saved this month</div>
        <div style={{ ...value, color: savedColor }}>{fmtCurrency(monthSaved)}</div>
        <div style={sub}>{monthLabel}</div>
      </div>

      <div style={card}>
        <div style={label}>Last Sync</div>
        <div style={{ ...value, fontSize: 18 }}>{fmtRelative(lastSyncAt)}</div>
        <div style={sub}>
          {lastSyncAt ? new Date(lastSyncAt).toLocaleDateString() : "—"}
        </div>
      </div>
    </section>
  )
}