import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useAlerts } from "./AlertsProvider"
import useMediaQuery from "./useMediaQuery"
import type { Severity } from "./types"

// ─────────────────────────────────────────────────────────────────
//  AlertsBell — the notification bell in the app header, and its slide-out.
//
//  Replaces the Overview "Alerts" wall (plan §7: "91 active" / "Show 89
//  more"). The panel shows the top TOP_COUNT alerts by severity plus the
//  total; dismissing one lets the next slide up. Reads everything from
//  AlertsProvider and fetches nothing itself.
//
//  Open/closed is local state, not a URL param: nothing needs to deep-link to
//  an open panel. If that changes, write it through lib/useUrlParams.
// ─────────────────────────────────────────────────────────────────

const TOP_COUNT = 5

const SEV_STYLE: Record<Severity, { bg: string; border: string; left: string; text: string; icon: string }> = {
  high:     { bg: "rgba(232,85,85,.07)",  border: "rgba(232,85,85,.2)",   left: "#e85555", text: "#c89080", icon: "⚠" },
  medium:   { bg: "rgba(240,160,48,.07)", border: "rgba(240,160,48,.2)",  left: "#f0a030", text: "#c8a060", icon: "▲" },
  low:      { bg: "rgba(74,158,255,.07)", border: "rgba(74,158,255,.15)", left: "#4a9eff", text: "#7898c8", icon: "ⓘ" },
  positive: { bg: "rgba(0,232,122,.07)",  border: "rgba(0,232,122,.15)",  left: "#00a856", text: "#6aaa88", icon: "✓" },
}

const mono = "'IBM Plex Mono', monospace"

const slideCss = `
@keyframes ledger-alerts-slide { from { transform: translateX(100%); } to { transform: translateX(0); } }
@keyframes ledger-alerts-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .ledger-alerts-panel, .ledger-alerts-backdrop { animation: none !important; }
}
`

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

export default function AlertsBell() {
  const { alerts, loading, error, reload, dismiss } = useAlerts()
  const isMobile = useMediaQuery("(max-width: 640px)")
  const [open, setOpen] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [dismissError, setDismissError] = useState<{ id: string; message: string } | null>(null)

  const bellRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  const close = useCallback(() => {
    setOpen(false)
    setDismissError(null)
    bellRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, close])

  const onDismiss = async (id: string) => {
    setPendingId(id)
    setDismissError(null)
    const message = await dismiss(id)
    setPendingId(null)
    if (message) setDismissError({ id, message })
  }

  const total = alerts.length
  const top = alerts.slice(0, TOP_COUNT)
  const badge = total > 99 ? "99+" : String(total)
  const label = loading ? "Alerts" : `Alerts, ${total} active`

  return (
    <>
      <button
        ref={bellRef}
        onClick={() => setOpen(true)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        style={{
          position: "relative",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 32, height: 28,
          background: "transparent", border: "1px solid #333", borderRadius: 4,
          color: total > 0 ? "#c8c4bd" : "#666", cursor: "pointer",
        }}
      >
        <BellIcon />
        {!loading && total > 0 && (
          <span aria-hidden="true" style={{
            position: "absolute", top: -7, right: -8,
            minWidth: 18, height: 18, padding: "0 5px", boxSizing: "border-box",
            borderRadius: 9, background: "#00e5a0", color: "#000",
            fontFamily: mono, fontSize: 10, fontWeight: 700, lineHeight: "18px",
            textAlign: "center",
          }}>{badge}</span>
        )}
      </button>

      {open && (
        <>
          <style>{slideCss}</style>
          <div
            className="ledger-alerts-backdrop"
            onClick={close}
            style={{
              position: "fixed", inset: 0, zIndex: 999,
              background: "rgba(0,0,0,.55)",
              animation: "ledger-alerts-fade .15s ease-out",
            }}
          />
          <aside
            className="ledger-alerts-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            style={{
              position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 1000,
              width: isMobile ? "100%" : 380, maxWidth: "100%",
              background: "#0d0d0d", borderLeft: "1px solid #222",
              display: "flex", flexDirection: "column",
              animation: "ledger-alerts-slide .2s ease-out",
              color: "#f0ede8",
            }}
          >
            <div style={{
              display: "flex", alignItems: "baseline", justifyContent: "space-between",
              padding: "20px 20px 16px", borderBottom: "1px solid #1a1a1a",
            }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <h2 id={titleId} style={{
                  margin: 0, fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
                  fontSize: 20, color: "#e8f4e8",
                }}>Alerts</h2>
                {!loading && !error && (
                  <span style={{ fontFamily: mono, fontSize: 12, color: "#555" }}>{total} active</span>
                )}
              </div>
              <button
                ref={closeRef}
                onClick={close}
                aria-label="Close alerts"
                style={{
                  background: "transparent", border: "1px solid #333", color: "#888",
                  padding: "4px 10px", borderRadius: 4, cursor: "pointer",
                  fontFamily: mono, fontSize: 11,
                }}
              >close</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
              {loading ? (
                <div style={{ fontFamily: mono, fontSize: 13, color: "#5a7a5a" }}>Loading alerts…</div>
              ) : error ? (
                <div style={{ fontFamily: mono, fontSize: 13, color: "#ff6b6b" }}>
                  ⚠ {error}
                  <div>
                    <button onClick={() => reload()} style={{
                      marginTop: 10, background: "transparent", border: "1px solid #333",
                      color: "#888", padding: "4px 10px", borderRadius: 4, cursor: "pointer",
                      fontFamily: mono, fontSize: 11,
                    }}>retry</button>
                  </div>
                </div>
              ) : total === 0 ? (
                <div style={{
                  color: "#5a7a5a", fontSize: 13, padding: 16,
                  border: "1px dashed #253325", borderRadius: 8, textAlign: "center",
                  fontFamily: mono, letterSpacing: ".04em",
                }}>
                  Nothing needs attention.
                </div>
              ) : (
                top.map((a) => {
                  const s = SEV_STYLE[a.severity] ?? SEV_STYLE.low
                  const pending = pendingId === a.id
                  return (
                    <div key={a.id} style={{ marginBottom: 8 }}>
                      <div style={{
                        background: s.bg, border: `1px solid ${s.border}`,
                        borderLeft: `3px solid ${s.left}`, borderRadius: 6,
                        padding: "12px 14px", fontSize: 13, color: s.text,
                        display: "flex", gap: 12, alignItems: "flex-start",
                      }}>
                        <span aria-hidden="true" style={{ fontSize: 14, flexShrink: 0 }}>{s.icon}</span>
                        <div style={{ flex: 1, lineHeight: 1.55, minWidth: 0 }}>
                          <strong style={{ color: "#e8f4e8", fontWeight: 500 }}>{a.title}</strong>
                          {a.body && <div style={{ marginTop: 3, fontSize: 12.5 }}>{a.body}</div>}
                        </div>
                        <button
                          onClick={() => onDismiss(a.id)}
                          disabled={pendingId !== null}
                          aria-label={`Dismiss: ${a.title}`}
                          style={{
                            background: "transparent", border: "none", color: "inherit",
                            opacity: pending ? 1 : .6,
                            cursor: pendingId !== null ? "not-allowed" : "pointer",
                            fontFamily: mono, fontSize: 10, letterSpacing: ".04em",
                            padding: "2px 4px", flexShrink: 0,
                          }}
                        >{pending ? "…" : "dismiss"}</button>
                      </div>
                      {dismissError?.id === a.id && (
                        <div role="alert" style={{
                          fontFamily: mono, fontSize: 11, color: "#ff6b6b", padding: "6px 4px 0",
                        }}>⚠ {dismissError.message}</div>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            {!loading && !error && total > TOP_COUNT && (
              <div style={{
                padding: "12px 20px", borderTop: "1px solid #1a1a1a",
                fontFamily: mono, fontSize: 11, color: "#5a7a5a",
              }}>
                Showing the top {TOP_COUNT} of {total}. Dismiss one to see the next.
              </div>
            )}
          </aside>
        </>
      )}
    </>
  )
}
