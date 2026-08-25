import React, { useEffect, useState } from "react"
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import type { Range, NetWorthResponse } from "./types"
import { colors, fonts } from "./tokens"
import { SkeletonChart } from "./Skeleton"
import {
  axisTick,
  axisLine,
  tooltipStyle,
  tooltipLabelStyle,
  formatTooltipValue,
  formatTooltipDate,
  legendStyle,
  ChartGradients,
} from "./chartTheme"

const RANGES: Range[] = ["1M", "3M", "6M", "1Y", "All"]

export default function NetWorthChart() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [range, setRange] = useState<Range>("6M")
  const [data, setData] = useState<NetWorthResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!demoMode && !isSignedIn) return

    setLoading(true)

    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/networth?range=${range}`)

        if (res.ok) setData(await res.json())
      } finally {
        setLoading(false)
      }
    })()
  }, [demoMode, isSignedIn, apiFetch, range])

  if (loading || !data) {
    return <SkeletonChart height={240} />
  }

  const { history, summary } = data
  const deltaPositive = (summary.deltaAbs ?? 0) >= 0
  const deltaColor = deltaPositive ? colors.greenDim : colors.coral
  const deltaSign = deltaPositive ? "+" : ""

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: fonts.serif,
              fontSize: 26,
              fontWeight: 300,
              color: colors.textHi,
              lineHeight: 1.1,
            }}
          >
            {summary.lastNetWorth === null
              ? "—"
              : formatTooltipValue(summary.lastNetWorth)}
          </div>

          {summary.deltaAbs !== null && (
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 11,
                color: deltaColor,
                marginTop: 4,
                textTransform: "uppercase",
                letterSpacing: ".06em",
              }}
            >
              {deltaSign}
              {formatTooltipValue(summary.deltaAbs)}
              {summary.deltaPct !== null &&
                ` (${deltaSign}${summary.deltaPct.toFixed(1)}%)`}{" "}
              in {range}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                fontFamily: fonts.mono,
                fontSize: 10.5,
                padding: "6px 14px",
                borderRadius: 20,
                border: `1px solid ${r === range ? colors.coral : colors.border2}`,
                background: r === range ? colors.coral : colors.surface2,
                color: r === range ? "#000" : colors.muted,
                cursor: "pointer",
                letterSpacing: ".04em",
                fontWeight: r === range ? 600 : 400,
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {history.length === 0 ? (
        <div
          style={{
            color: colors.muted,
            fontSize: 13,
            padding: "40px 0",
            textAlign: "center",
          }}
        >
          No snapshots in this range yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart
            data={history}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <ChartGradients />

            <XAxis
              dataKey="date"
              tickFormatter={formatTooltipDate}
              tick={axisTick}
              axisLine={axisLine}
              tickLine={false}
              minTickGap={40}
            />

            <YAxis
              tickFormatter={formatTooltipValue}
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={60}
            />

            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={tooltipLabelStyle}
              labelFormatter={(label: any) => formatTooltipDate(label as string)}
              formatter={(v: any, name: any) => [formatTooltipValue(v as number), name]}
            />

            <Area
              type="monotone"
              dataKey="depository"
              stackId="assets"
              stroke={colors.greenDim}
              strokeWidth={1}
              fill="url(#grad-green)"
              name="Cash"
            />

            <Area
              type="monotone"
              dataKey="investment"
              stackId="assets"
              stroke={colors.blue}
              strokeWidth={1}
              fill="url(#grad-blue)"
              name="Investment"
            />

            <Line
              type="monotone"
              dataKey="netWorth"
              stroke={colors.green}
              strokeWidth={2}
              dot={false}
              name="Net worth"
            />

            <Legend
              wrapperStyle={legendStyle}
              iconType="plainline"
              iconSize={14}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {summary.dataLimited && (
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: colors.muted,
            marginTop: 8,
            textAlign: "center",
            letterSpacing: ".04em",
          }}
        >
          Limited to {summary.daysCovered}{" "}
          {summary.daysCovered === 1 ? "day" : "days"} of available data.
        </div>
      )}
    </div>
  )
}