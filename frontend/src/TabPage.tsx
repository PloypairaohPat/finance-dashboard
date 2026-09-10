import React from "react"
import useMediaQuery from "./useMediaQuery"

// ─────────────────────────────────────────────────────────────────
//  TabPage — the page chrome every tab view shares.
//
//  Deliberately minimal for now: background, width, and a titled header.
//  The app header (word-mark, sync/link buttons, Exit demo / UserButton) is
//  still inside the Overview dashboard and moves up to app level in stage 4,
//  when the nav shell lands. Until then tabs other than Overview render
//  without it.
// ─────────────────────────────────────────────────────────────────

export default function TabPage({
  title,
  count,
  children,
}: {
  title: string
  /** Small muted text beside the title, e.g. "142 shown". */
  count?: string
  children: React.ReactNode
}) {
  const isMobile = useMediaQuery("(max-width: 640px)")

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a0a",
      color: "#f0ede8",
      fontFamily: "'Syne', sans-serif",
    }}>
      <main style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: isMobile ? "28px 16px 48px" : "48px 40px 72px",
      }}>
        <header style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 24,
          borderBottom: "1px solid #1a1a1a",
          paddingBottom: 16,
        }}>
          <h1 style={{
            fontFamily: "Fraunces, Georgia, serif",
            fontWeight: 300,
            fontSize: isMobile ? 24 : 30,
            color: "#e8f4e8",
            margin: 0,
            letterSpacing: "-.01em",
          }}>{title}</h1>
          {count && (
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              color: "#555",
            }}>{count}</span>
          )}
        </header>
        {children}
      </main>
    </div>
  )
}
