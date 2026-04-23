import React, { useEffect, useState } from "react"
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import type { Range, NetWorthResponse } from "./types"

const RANGES: Range[] = ["1M", "3M", "6M", "1Y", "All"]

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
const fmtShort = (iso: string) => {
  const d = new Date(iso + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export default function NetWorthChart() {
  const { getToken, isSignedIn } = useAuth()
  const [range, setRange] = useState<Range>("6M")
  const [data, setData] = useState<NetWorthResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isSignedIn) return
    setLoading(true)
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/networth?range=${range}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setData(await res.json())
      } finally { setLoading(false) }
    })()
  }, [isSignedIn, getToken, range])

  if (loading || !data) {
    return <div style={{ color: "#5a7a5a", fontSize: 13, padding: 20 }}>Loading net worth…</div>
  }

  const { history, summary } = data
  const deltaPositive = (summary.deltaAbs ?? 0) >= 0
  const deltaColor = deltaPositive ? "#00a856" : "#ff7a6b"
  const deltaSign = deltaPositive ? "+" : ""

  return (
    <div>
      {/* Header: current net worth + delta + range pills */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "flex-start", gap: 12, marginBottom: 16, flexWrap: "wrap",
      }}>
        <div>
          <div style={{
            fontFamily: "Fraunces, Georgia, serif", fontSize: 26,
            fontWeight: 300, color: "#e8f4e8", lineHeight: 1.1,
          }}>
            {summary.lastNetWorth === null ? "—" : fmtCurrency(summary.lastNetWorth)}
          </div>
          {summary.deltaAbs !== null && (
            <div style={{
              fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
              color: deltaColor, marginTop: 4,
              textTransform: "uppercase", letterSpacing: ".06em",
            }}>
              {deltaSign}{fmtCurrency(summary.deltaAbs)}
              {summary.deltaPct !== null && ` (${deltaSign}${summary.deltaPct.toFixed(1)}%)`} in {range}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {RANGES.map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5,
              padding: "6px 14px", borderRadius: 20,
              border: "1px solid " + (r === range ? "#ff7a6b" : "#253325"),
              background: r === range ? "#ff7a6b" : "#161e14",
              color: r === range ? "#000" : "#5a7a5a",
              cursor: "pointer", letterSpacing: ".04em",
              fontWeight: r === range ? 600 : 400,
              transition: "all .15s",
            }}>{r}</button>
          ))}
        </div>
      </div>

      {/* Chart */}
      {history.length === 0 ? (
        <div style={{ color: "#5a7a5a", fontSize: 13, padding: "40px 0", textAlign: "center" }}>
          No snapshots in this range yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="gradDep" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00e87a" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#00e87a" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradInv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4a9eff" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#4a9eff" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date" tickFormatter={fmtShort}
              tick={{ fill: "#5a7a5a", fontSize: 10, fontFamily: "IBM Plex Mono, monospace" }}
              axisLine={{ stroke: "#1e2b1e" }} tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v) => fmtCurrency(v)}
              tick={{ fill: "#5a7a5a", fontSize: 10, fontFamily: "IBM Plex Mono, monospace" }}
              axisLine={false} tickLine={false} width={60}
            />
            <Tooltip
            contentStyle={{
              background: "#161e14", border: "1px solid #253325",
              borderRadius: 6, fontSize: 12,
            }}
            labelFormatter={fmtShort as any}
            formatter={((v: number, name: string) => [fmtCurrency(v), name]) as any}
            />
            <Area
              type="monotone" dataKey="depository" stackId="assets"
              stroke="#00a856" strokeWidth={1} fill="url(#gradDep)" name="Cash"
            />
            <Area
              type="monotone" dataKey="investment" stackId="assets"
              stroke="#4a9eff" strokeWidth={1} fill="url(#gradInv)" name="Investment"
            />
            <Line
              type="monotone" dataKey="netWorth" stroke="#00e87a"
              strokeWidth={2} dot={false} name="Net worth"
            />
            <Legend
              wrapperStyle={{
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a",
                paddingTop: 8,
              }}
              iconType="plainline" iconSize={14}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {summary.dataLimited && (
        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
          color: "#5a7a5a", marginTop: 8,
          textAlign: "center",
          letterSpacing: ".04em",
        }}>
          Limited to {summary.daysCovered} {summary.daysCovered === 1 ? "day" : "days"} of available data.
        </div>
      )}
    </div>
  )
}