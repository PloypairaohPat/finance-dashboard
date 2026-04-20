import { useState, useEffect } from "react"
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"

interface NetWorthPoint {
  date: string
  assets: number
  liabilities: number
  netWorth: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as NetWorthPoint

  return (
    <div
      style={{
        background: "#111710",
        border: "1px solid #253325",
        borderRadius: 8,
        padding: "12px 16px",
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 12,
      }}
    >
      <div style={{ color: "#5a7a5a", marginBottom: 6 }}>{label}</div>
      <div style={{ color: "#00e87a", marginBottom: 3 }}>Assets: {fmt(d.assets)}</div>
      <div style={{ color: "#e85555", marginBottom: 3 }}>Liabilities: {fmt(d.liabilities)}</div>
      <div
        style={{
          color: "#b07aff",
          fontWeight: 600,
          borderTop: "1px solid #253325",
          paddingTop: 6,
          marginTop: 4,
        }}
      >
        Net Worth: {fmt(d.netWorth)}
      </div>
    </div>
  )
}

export default function NetWorthChart() {
  const [data, setData] = useState<NetWorthPoint[]>([])
  const [loading, setLoading] = useState(true)
  const { getToken } = useAuth()

  useEffect(() => {
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/networth?days=90`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const json = await res.json()
        setData(json.history ?? [])
      } catch (e: any) {
        console.error("NetWorth fetch failed:", e.message)
      } finally {
        setLoading(false)
      }
    })()
  }, [getToken])

  if (loading) {
    return (
      <div
        style={{
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 13,
          color: "#5a7a5a",
          padding: "40px 0",
        }}
      >
        Loading net worth data…
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div
        style={{
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 13,
          color: "#5a7a5a",
          padding: "40px 0",
        }}
      >
        No snapshots yet. Trigger a Plaid sync to capture your first data point.
      </div>
    )
  }

  const latest = data[data.length - 1]

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          { label: "Net Worth", value: latest.netWorth, color: "#b07aff" },
          { label: "Total Assets", value: latest.assets, color: "#00e87a" },
          { label: "Liabilities", value: latest.liabilities, color: "#e85555" },
        ].map(card => (
          <div
            key={card.label}
            style={{
              flex: "1 1 150px",
              background: "#111",
              border: "1px solid #1e1e1e",
              borderRadius: 10,
              padding: "16px 20px",
            }}
          >
            <div
              style={{
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 10,
                color: "#555",
                textTransform: "uppercase",
                letterSpacing: "1px",
                marginBottom: 6,
              }}
            >
              {card.label}
            </div>
            <div
              style={{
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 22,
                fontWeight: 500,
                color: card.color,
              }}
            >
              {fmt(card.value)}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: "#111",
          border: "1px solid #1e1e1e",
          borderRadius: 12,
          padding: "24px 20px 16px",
        }}
      >
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <defs>
              <linearGradient id="gradNet" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#b07aff" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#b07aff" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradAssets" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00e87a" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#00e87a" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />

            <XAxis
              dataKey="date"
              tick={{ fill: "#555", fontFamily: "IBM Plex Mono", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "#222" }}
              tickFormatter={(d: string) => {
                const [, m, day] = d.split("-")
                return `${m}/${day}`
              }}
            />

            <YAxis
              tick={{ fill: "#555", fontFamily: "IBM Plex Mono", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
            />

            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#333" strokeDasharray="3 3" />

            <Area
              type="monotone"
              dataKey="assets"
              stroke="#00e87a"
              strokeWidth={1.5}
              fill="url(#gradAssets)"
            />

            <Area
              type="monotone"
              dataKey="netWorth"
              stroke="#b07aff"
              strokeWidth={2}
              fill="url(#gradNet)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
