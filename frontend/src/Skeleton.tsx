import React from "react"
import { colors, radius } from "./tokens"

interface SkeletonProps {
  width?: number | string
  height?: number | string
  borderRadius?: string
  style?: React.CSSProperties
}

export default function Skeleton({
  width = "100%", height = 12, borderRadius = radius.sm, style,
}: SkeletonProps) {
  return (
    <div
      className="skeleton-pulse"
      aria-hidden="true"
      style={{
        width, height, borderRadius,
        background: colors.border,
        ...style,
      }}
    />
  )
}

// — — — Preset variants — — —

export function SkeletonRow() {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "36px 1fr auto",
      gap: 14, padding: "12px 0",
      borderBottom: `1px solid ${colors.border}`,
      alignItems: "center",
    }}>
      <Skeleton width={32} height={32} borderRadius="50%" />
      <div>
        <Skeleton width="60%" height={12} style={{ marginBottom: 6 }} />
        <Skeleton width="40%" height={9} />
      </div>
      <Skeleton width={60} height={14} />
    </div>
  )
}

export function SkeletonStat() {
  return (
    <div style={{
      background: colors.surface3, border: `1px solid ${colors.border}`,
      borderRadius: radius.md, padding: "10px 12px",
    }}>
      <Skeleton width={40} height={9} style={{ marginBottom: 6 }} />
      <Skeleton width="70%" height={20} />
    </div>
  )
}

export function SkeletonChart({ height = 240 }: { height?: number }) {
  return (
    <Skeleton width="100%" height={height} borderRadius={radius.lg} />
  )
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div>{Array.from({ length: rows }).map((_, i) => <SkeletonRow key={i} />)}</div>
  )
}