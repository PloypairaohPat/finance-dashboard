import { useEffect, useState } from "react"
import {
  ComposedChart,
  Bar,
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

interface CashFlowMonth {
  month: string
  income: number
  expenses: number
  net: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)

const monthLabel = (m: string) => {
  const [year, mo] = m.split("-")
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${names[parseInt(mo, 10) - 1]} '${year.slice(2)}`
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as CashFlowMonth

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
      <div style={{ color: "#5a7a5a", marginBottom: 6 }}>{monthLabel(d.month)}</div>
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
  const [data, setData] = useState<CashFlowMonth[]>([])
  const [loading, setLoading] = useState(true)
  const apiFetch = useApiFetch()

  useEffect(() => {
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/cashflow?months=6`)
        const json = await res.json()
        setData(json.cashflow ?? [])
      } catch (e: any) {
        console.error("CashFlow fetch failed:", e.message)
      } finally {
        setLoading(false)
      }
    })()
  }, [apiFetch])

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
        No transaction data available for cash flow analysis.
      </div>
    )
  }

  const current = data[data.length - 1]
  const avgIncome = data.reduce((s, d) => s + d.income, 0) / data.length
  const avgExpenses = data.reduce((s, d) => s + d.expenses, 0) / data.length
  const avgNet = avgIncome - avgExpenses

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          { label: "Income This Month", value: current.income, color: "#00e87a" },
          { label: "Expenses This Month", value: current.expenses, color: "#e85555" },
          { label: "Net Cash Flow", value: current.net, color: current.net >= 0 ? "#00d4aa" : "#e85555" },
          { label: "Avg Monthly Net", value: avgNet, color: avgNet >= 0 ? "#00d4aa" : "#e85555" },
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
              {card.value >= 0 ? "" : ""}
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
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
            <XAxis
              dataKey="month"
              tick={{ fill: "#555", fontFamily: "IBM Plex Mono", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "#222" }}
              tickFormatter={monthLabel}
            />
            <YAxis
              tick={{ fill: "#555", fontFamily: "IBM Plex Mono", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#333" strokeDasharray="3 3" />
            <Bar dataKey="income" fill="#00e87a" fillOpacity={0.7} radius={[3, 3, 0, 0]} barSize={28} />
            <Bar dataKey="expenses" fill="#e85555" fillOpacity={0.7} radius={[3, 3, 0, 0]} barSize={28} />
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
        </div>
      </div>
    </div>
  )
}
