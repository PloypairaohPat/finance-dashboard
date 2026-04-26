// M5.10 — Shared Recharts styling so all charts look like siblings.
// Import these in every chart component.

import React from "react"
import { colors, fonts, radius } from "./tokens"

export const axisTick = {
  fill: colors.muted,
  fontSize: 10,
  fontFamily: fonts.mono,
} as const

export const axisLine = { stroke: colors.border } as const

export const tooltipStyle = {
  background: colors.surface2,
  border: `1px solid ${colors.border2}`,
  borderRadius: radius.md,
  fontSize: 12,
  fontFamily: fonts.sans,
  padding: "8px 12px",
} as const

export const tooltipLabelStyle = {
  fontFamily: fonts.mono,
  fontSize: 10,
  color: colors.muted,
  textTransform: "uppercase" as const,
  letterSpacing: ".06em",
  marginBottom: 4,
} as const

export const gridStyle = {
  stroke: colors.border,
  strokeDasharray: "3 3",
} as const

export const legendStyle = {
  fontFamily: fonts.mono,
  fontSize: 10,
  color: colors.muted,
  paddingTop: 8,
} as const

// Standard currency formatter for tooltip values
export const formatTooltipValue = (n: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n)

// Standard short date formatter for axis labels
export const formatTooltipDate = (iso: string): string => {
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""))
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// Standard SVG gradient defs — drop into chart components as needed
export const ChartGradients = () => (
  <defs>
    <linearGradient id="grad-green" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={colors.green} stopOpacity={0.25} />
      <stop offset="100%" stopColor={colors.green} stopOpacity={0.02} />
    </linearGradient>
    <linearGradient id="grad-blue" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={colors.blue} stopOpacity={0.22} />
      <stop offset="100%" stopColor={colors.blue} stopOpacity={0.02} />
    </linearGradient>
    <linearGradient id="grad-coral" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={colors.coral} stopOpacity={0.22} />
      <stop offset="100%" stopColor={colors.coral} stopOpacity={0.02} />
    </linearGradient>
  </defs>
)
