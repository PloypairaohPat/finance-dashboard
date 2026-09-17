import { useEffect, useState } from "react"
import {
  ComposedChart,
  Bar,
  Cell,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"
import { useApiFetch } from "./lib/useApiFetch"
import { API_URL } from "./config"
import { useSyncVersion } from "./SyncProvider"
import { periodProgress, useSettings } from "./SettingsProvider"
import type { PeriodInfo } from "./types"

// One bar group per money period (M7.2), oldest first. Every period in the
// window is present, including empty ones (zero bars, not gaps). The current
// period is in progress: its bars are drawn faded and labelled "so far" — it is
// never projected to a full period.
interface CashFlowPeriod extends PeriodInfo {
  month: string
  income: number
  expenses: number
  net: number
  txCount: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as CashFlowPeriod
  const progress = periodProgress(d)

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
      <div style={{ color: "#5a7a5a", marginBottom: progress ? 2 : 6 }}>{d.label}</div>
      {progress && <div style={{ color: "#f0a030", fontSize: 10.5, marginBottom: 6 }}>{progress}</div>}
      <div style={{ color: "#00e87a", marginBottom: 3 }}>Income: {fmt(d.income)}</div>
      <div style={{ color: "#e85555", marginBottom: 3 }}>Expenses: {fmt(d.expenses)}</div>
      <div
        style={{
          color: d.net >= 0 ? "#00d4aa" : "#e85555",
          fontWeight: 600,
          borderTop: "1px solid #253325",
          paddingTop: 6,
          marginTop: 4,
        }}
      >
        Net: {d.net >= 0 ? "+" : ""}
        {fmt(d.net)}
      </div>
    </div>
  )
}

export default function CashFlowChart() {
  const [data, setData] = useState<CashFlowPeriod[]>([])
  const [loading, setLoading] = useState(true)
  const apiFetch = useApiFetch()
  const syncVersion = useSyncVersion()
  const { version: settingsVersion } = useSettings()

  // Re-runs after every sync and every period-setting change; the current chart
  // stays on screen meanwhile, and a superseded run's response is ignored.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/cashflow?months=6`)
        const json = await res.json()
        if (!cancelled) setData(json.cashflow ?? [])
      } catch (e: any) {
        console.error("CashFlow fetch failed:", e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [apiFetch, syncVersion, settingsVersion])

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
        Loading cash flow data...
      </div>
    )
  }

  if (data.length === 0 || data.every((d) => d.txCount === 0)) {
    return (
      <div
        style={{
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: 13,
          color: "#5a7a5a",
          padding: "40px 0",
        }}
      >
        No transaction data available for cash flow analysis.
      </div>
    )
  }

  const current = data[data.length - 1]
  const noun = current.startDay === 1 ? "Month" : "Period"
  const progress = periodProgress(current)
  const avgIncome = data.reduce((s, d) => s + d.income, 0) / data.length
  const avgExpenses = data.reduce((s, d) => s + d.expenses, 0) / data.length
  const avgNet = avgIncome - avgExpenses
  const chartData = data.map((d) => ({ ...d, axisLabel: d.inProgress ? `${d.tickLabel} · so far` : d.tickLabel }))

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: progress ? 8 : 24, flexWrap: "wrap" }}>
        {[
          { label: `Income This ${noun}`, value: current.income, color: "#00e87a" },
          { label: `Expenses This ${noun}`, value: current.expenses, color: "#e85555" },
          { label: "Net Cash Flow", value: current.net, color: current.net >= 0 ? "#00d4aa" : "#e85555" },
          { label: `Avg ${noun === "Month" ? "Monthly" : "Per-Period"} Net`, value: avgNet, color: avgNet >= 0 ? "#00d4aa" : "#e85555" },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              flex: "1 1 140px",
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
                fontSize: 20,
                fontWeight: 500,
                color: card.color,
              }}
            >
              {fmt(card.value)}
            </div>
          </div>
        ))}
      </div>

      {progress && (
        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10.5, color: "#f0a030",
          marginBottom: 20, letterSpacing: ".04em",
        }}>
          {current.label} · {progress}
        </div>
      )}

      <div
        style={{
          background: "#111",
          border: "1px solid #1e1e1e",
          borderRadius: 12,
          padding: "24px 20px 16px",
        }}
      >
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
            <XAxis
              dataKey="axisLabel"
              tick={{ fill: "#555", fontFamily: "IBM Plex Mono", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "#222" }}
            />
            <YAxis
              tick={{ fill: "#555", fontFamily: "IBM Plex Mono", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#333" strokeDasharray="3 3" />
            <Bar dataKey="income" fill="#00e87a" fillOpacity={0.7} radius={[3, 3, 0, 0]} barSize={28}>
              {chartData.map((d) => <Cell key={d.key} fillOpacity={d.inProgress ? 0.3 : 0.7} />)}
            </Bar>
            <Bar dataKey="expenses" fill="#e85555" fillOpacity={0.7} radius={[3, 3, 0, 0]} barSize={28}>
              {chartData.map((d) => <Cell key={d.key} fillOpacity={d.inProgress ? 0.3 : 0.7} />)}
            </Bar>
            <Line
              type="monotone"
              dataKey="net"
              stroke="#00d4aa"
              strokeWidth={2.5}
              dot={{ fill: "#00d4aa", r: 4, strokeWidth: 0 }}
              activeDot={{ r: 6, fill: "#00d4aa", stroke: "#111", strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 24,
            marginTop: 12,
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 10,
            color: "#555",
            flexWrap: "wrap",
          }}
        >
          <span>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 2,
                background: "#00e87a",
                marginRight: 6,
                opacity: 0.7,
              }}
            />
            Income
          </span>
          <span>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 2,
                background: "#e85555",
                marginRight: 6,
                opacity: 0.7,
              }}
            />
            Expenses
          </span>
          <span>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#00d4aa",
                marginRight: 6,
              }}
            />
            Net Flow
          </span>
          {current.inProgress && <span>Faded bars: period in progress</span>}
        </div>
      </div>
    </div>
  )
}
