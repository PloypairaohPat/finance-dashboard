import React from "react"

// ─────────────────────────────────────────────────────────────────
//  PendingChip — "this hasn't posted yet".
//
//  Pending rows count in every figure (M7.3), so a row that's counted and
//  pending says so wherever it's shown: the transaction list and panel,
//  Largest purchases, Top merchants and Subscriptions. Never shrinks: on a
//  narrow screen the text beside it ellipsizes first.
// ─────────────────────────────────────────────────────────────────

export const PENDING_TITLE = "Not posted yet. It counts in your totals now, and may change or be replaced when it posts."

export default function PendingChip({ label = "Pending" }: { label?: string }) {
  return (
    <span data-testid="pending-chip" title={PENDING_TITLE} style={{
      fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
      padding: "1px 6px", borderRadius: 3,
      background: "rgba(240,160,48,.10)", color: "#f0a030",
      border: "1px dashed rgba(240,160,48,.45)",
      textTransform: "uppercase", letterSpacing: ".06em",
      whiteSpace: "nowrap", flexShrink: 0,
    }}>{label}</span>
  )
}
