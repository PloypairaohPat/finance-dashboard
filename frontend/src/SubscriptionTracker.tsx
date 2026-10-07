import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import { useSyncVersion } from "./SyncProvider"
import type { SubscriptionAnalysis, EnrichedStream, Frequency, SuggestedStream, Verdict } from "./types"
import PendingChip from "./PendingChip"
import { readWriteResult } from "./lib/writeResult"

// ─────────────────────────────────────────────────────────────────
//  SubscriptionTracker — the Subscriptions & Bills tab.
//
//  M7.6 PR 5d: Suggested (outside every total, Confirm and Dismiss), "Not
//  recurring" on every row that is a Plaid stream, Undo after a dismiss, and
//  a collapsed "Dismissed (n)" with Restore. All of it renders only when the
//  response carries it: `suggested` and `dismissed` arrive with PR 5e, and
//  only streams (source "plaid") can be dismissed, so until then the tab
//  looks exactly as before. Writes go through readWriteResult, so demo mode
//  shows its message and nothing claims to have saved.
// ─────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
const fmtInt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

const FREQ_LABEL: Record<Frequency, string> = {
  WEEKLY: "weekly", BIWEEKLY: "biweekly", SEMI_MONTHLY: "semi-monthly",
  MONTHLY: "monthly", ANNUALLY: "annually",
  // A marked subscription with one charge so far: no schedule, so no monthly cost yet.
  UNKNOWN: "schedule unknown",
}

const card: React.CSSProperties = {
  background: "#161e14", border: "1px solid #253325",
  borderRadius: 10, padding: 20, marginBottom: 20,
}
const cardHead: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  marginBottom: 14,
}
const cardTitle: React.CSSProperties = {
  fontFamily: "Fraunces, Georgia, serif", fontWeight: 300,
  fontSize: 16, color: "#e8f4e8",
}
const cardTotal: React.CSSProperties = {
  fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
  color: "#5a7a5a", textTransform: "uppercase", letterSpacing: ".06em",
}

/** "Updated 3h ago": how old the stalest Item's streams are. */
export function updatedLabel(oldest: string | null, now: number = Date.now()): string {
  if (!oldest) return "Not updated yet"
  const m = Math.floor((now - new Date(oldest).getTime()) / 60000)
  if (m < 1) return "Updated just now"
  if (m < 60) return `Updated ${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `Updated ${h}h ago`
  return `Updated ${Math.floor(h / 24)}d ago`
}

const chip = (color: string, bg: string, border: string): React.CSSProperties => ({
  fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
  padding: "2px 6px", borderRadius: 3, background: bg, color, border: `1px solid ${border}`,
  textTransform: "uppercase", letterSpacing: ".06em", flexShrink: 0, whiteSpace: "nowrap",
})

function ActionButton({ onClick, disabled, label, children }: {
  onClick: () => void; disabled: boolean; label: string; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        fontFamily: "IBM Plex Mono, monospace", fontSize: 11, padding: "4px 10px", borderRadius: 4,
        background: "transparent", color: disabled ? "#3a4a3a" : "#8ab88a",
        border: "1px solid #253325", cursor: disabled ? "default" : "pointer",
      }}
    >{children}</button>
  )
}

/** The tab's pending chip: the amount beside it is the last posted charge, not the pending one. */
export const SUBSCRIPTION_PENDING_TITLE =
  "The newest charge is still pending. Totals and price changes use posted charges only, so it counts once it posts."

/** Why a confirmation no longer counts, for its chip's tooltip. */
export const NOT_COUNTED_TITLE: Record<"not-spending" | "removed", string> = {
  "not-spending": "You confirmed this, but its charge isn't counted as spending any more (it's now a transfer or similar), so it's left out of your totals. Unmark it if it no longer applies.",
  "removed": "You confirmed this, but your bank has since removed its charge, so it's left out of your totals. Unmark it if it no longer applies.",
}

function StreamRow({ s, chips, actions, showMark = true }: {
  s: EnrichedStream; chips?: React.ReactNode; actions?: React.ReactNode
  /** Off where `mark` isn't a confirmation: on a dismissed stream it's the dismissal. */
  showMark?: boolean
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: 12, padding: "10px 0",
      borderBottom: "1px solid #1e2b1e",
    }}>
      <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{
          fontSize: 13.5, color: "#d4e8d4",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{s.merchant}</span>
        {s.priceChange && s.priceChange.pctChange > 0 && (
          <span style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
            padding: "2px 6px", borderRadius: 3,
            background: "rgba(232,85,85,.15)", color: "#e85555",
            border: "1px solid rgba(232,85,85,.3)",
            textTransform: "uppercase", letterSpacing: ".06em",
            flexShrink: 0,
          }}>+{s.priceChange.pctChange.toFixed(0)}%</span>
        )}
        {s.isDuplicate && (
          <span style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
            padding: "2px 6px", borderRadius: 3,
            background: "rgba(240,160,48,.15)", color: "#f0a030",
            border: "1px solid rgba(240,160,48,.3)",
            textTransform: "uppercase", letterSpacing: ".06em",
            flexShrink: 0,
          }}>dup</span>
        )}
        {/* Chips never shrink: the name ellipsizes first, so they stay readable at phone width. */}
        {chips}
        {showMark && s.mark && (
          <span title="You confirmed this one" style={chip("#4a9eff", "rgba(74,158,255,.12)", "rgba(74,158,255,.3)")}>Confirmed by you</span>
        )}
        {s.notCounted && (
          <span title={NOT_COUNTED_TITLE[s.notCounted.reason]} style={chip("#f0a030", "rgba(240,160,48,.12)", "rgba(240,160,48,.3)")}>Not counted</span>
        )}
        {s.status === "ended" && (
          <span title={s.source === "plaid"
            ? "Plaid reports this has stopped: shown, but not counted in the totals"
            : "No charge for two billing periods: not counted in the totals"} style={{
            fontFamily: "IBM Plex Mono, monospace", fontSize: 9,
            padding: "2px 6px", borderRadius: 3,
            background: "rgba(90,122,90,.15)", color: "#8ab88a",
            border: "1px solid #253325",
            textTransform: "uppercase", letterSpacing: ".06em",
            flexShrink: 0, whiteSpace: "nowrap",
          }}>Ended</span>
        )}
      </div>
      {actions && <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}>{actions}</div>}
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{
          fontFamily: "Fraunces, Georgia, serif", fontSize: 14, color: "#e8f4e8",
        }}>{fmt(s.lastAmount)}</div>
        <div style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a",
          marginTop: 2,
        }}>{FREQ_LABEL[s.frequency]}</div>
        {/* The amount above is a charge that hasn't posted yet. */}
        {/* The newest charge hasn't posted. Its date counts; its amount doesn't yet. */}
        {s.lastChargePending && <div style={{ marginTop: 3 }}><PendingChip title={SUBSCRIPTION_PENDING_TITLE} /></div>}
      </div>
    </div>
  )
}

function UpcomingRow({ s }: { s: EnrichedStream }) {
  const days = s.daysUntilNextCharge ?? 0
  const label = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`
  const urgent = days <= 3
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 12, padding: "8px 0",
      borderBottom: "1px solid #1e2b1e",
      alignItems: "center",
    }}>
      <span style={{
        fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
        padding: "2px 8px", borderRadius: 3,
        background: urgent ? "rgba(232,85,85,.15)" : "rgba(74,158,255,.15)",
        color: urgent ? "#e85555" : "#4a9eff",
        border: `1px solid ${urgent ? "rgba(232,85,85,.3)" : "rgba(74,158,255,.3)"}`,
        textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap",
      }}>{label}</span>
      <span style={{ fontSize: 13, color: "#d4e8d4" }}>{s.merchant}</span>
      <span style={{
        fontFamily: "Fraunces, Georgia, serif", fontSize: 14, color: "#e8f4e8",
      }}>{fmt(s.lastAmount)}</span>
    </div>
  )
}

export default function SubscriptionTracker() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()
  const [data, setData] = useState<SubscriptionAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const syncVersion = useSyncVersion()
  // Bumped after a write, to read the tab again.
  const [reloads, setReloads] = useState(0)
  const [busy, setBusy] = useState(false)
  /** What a write said instead of saving: an error, or demo mode's message. */
  const [notice, setNotice] = useState<{ tone: "error" | "demo"; text: string } | null>(null)
  /** The dismissal just made, for Undo. */
  const [undo, setUndo] = useState<{ merchant: string; verdictId: string } | null>(null)

  // Re-runs after every sync; the current list stays on screen meanwhile, and a
  // superseded run's response is ignored.
  useEffect(() => {
    // Clear loading on the early return too (the stage 0.5 InsightsDashboard bug).
    if (!demoMode && !isSignedIn) {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/subscriptions`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setData(json)
        setError(null)
      } catch (e: any) {
        if (!cancelled) setError(`Couldn't load subscriptions: ${e.message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [demoMode, isSignedIn, apiFetch, syncVersion, reloads])

  /** One write. Returns its body when it saved, null when it didn't (and says why). */
  const write = async (send: () => Promise<Response>): Promise<unknown | null> => {
    setBusy(true)
    try {
      const result = await readWriteResult(await send())
      if (!result.ok) {
        setNotice({ tone: result.demo ? "demo" : "error", text: result.message })
        return null
      }
      setNotice(null)
      setReloads((n) => n + 1)
      return result.data ?? {}
    } catch (e: any) {
      setNotice({ tone: "error", text: e.message })
      return null
    } finally {
      setBusy(false)
    }
  }
  // Anchored on the stream's newest posted charge: a verdict applies while its
  // anchor is in the stream, and when Plaid regroups or splits one, the newest
  // charge stays with the part still running. With nothing posted yet, the
  // newest charge: the server refuses it with its "still pending" message.
  const anchorOf = (s: EnrichedStream) => s.anchorTxId ?? s.txIds[s.txIds.length - 1]
  const answer = (s: EnrichedStream, verdict: Verdict["kind"]) => write(() => apiFetch(`${API_URL}/subscriptions/verdicts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactionId: anchorOf(s), verdict }),
  }))
  const removeVerdict = (id: string) => write(() => apiFetch(`${API_URL}/subscriptions/verdicts/${id}`, { method: "DELETE" }))

  const confirm = async (s: EnrichedStream) => {
    setUndo(null)
    await answer(s, "confirmed")
  }
  const dismiss = async (s: EnrichedStream) => {
    setUndo(null)
    const body = (await answer(s, "dismissed")) as { verdict?: Verdict } | null
    if (body?.verdict) setUndo({ merchant: s.merchant, verdictId: body.verdict.id })
  }
  const undoDismiss = async () => {
    if (!undo) return
    if ((await removeVerdict(undo.verdictId)) !== null) setUndo(null)
  }

  if (loading) {
    return <div style={{ color: "#5a7a5a", fontSize: 13, padding: 20 }}>Loading subscriptions…</div>
  }
  // A failed fetch used to leave data null and fall into "Loading…" forever.
  if (error || !data) {
    return <div style={{ color: "#ff6b6b", fontSize: 13, padding: 20 }}>⚠ {error ?? "Couldn't load subscriptions."}</div>
  }

  const { subscriptions, bills, upcoming, alerts, totals, suggested, dismissed, freshness } = data
  const rowKey = (s: EnrichedStream) => `${s.key}:${s.txIds[0] ?? ""}:${s.mark?.id ?? ""}`
  // Only a Plaid stream can be dismissed; a marked series is undone from its
  // charge. A confirmation that no longer counts gets Unmark on its row: its
  // charge may be one the bank removed, which can't be opened.
  const rowActions = (s: EnrichedStream) => {
    if (s.notCounted && s.mark) {
      const markId = s.mark.id
      return <ActionButton onClick={() => removeVerdict(markId)} disabled={busy} label={`Unmark ${s.merchant}`}>Unmark</ActionButton>
    }
    return s.source === "plaid" ? (
      <ActionButton onClick={() => dismiss(s)} disabled={busy} label={`${s.merchant} is not recurring`}>Not recurring</ActionButton>
    ) : undefined
  }

  return (
    <div>
      {/* How current the streams are, by the stalest Item. Sync refreshes them. */}
      {freshness && (
        <div title="Refreshed when your bank reports changes, at least daily, and whenever you press Sync" style={{
          fontFamily: "IBM Plex Mono, monospace", fontSize: 10, color: "#5a7a5a",
          textAlign: "right", marginBottom: 10, letterSpacing: ".04em",
        }}>{updatedLabel(freshness.oldest)}</div>
      )}
      {notice && (
        <div role={notice.tone === "error" ? "alert" : "status"} style={{
          marginBottom: 14, padding: "10px 14px", borderRadius: 6, fontSize: 12.5,
          background: notice.tone === "error" ? "rgba(232,85,85,.07)" : "rgba(74,158,255,.07)",
          border: `1px solid ${notice.tone === "error" ? "rgba(232,85,85,.25)" : "rgba(74,158,255,.25)"}`,
          color: notice.tone === "error" ? "#e88a8a" : "#9cc4ef",
        }}>{notice.tone === "error" ? "⚠ " : ""}{notice.text}</div>
      )}
      {undo && (
        <div role="status" style={{
          marginBottom: 14, padding: "8px 14px", borderRadius: 6, fontSize: 12.5,
          background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
        }}>
          <span>Dismissed {undo.merchant}.</span>
          <ActionButton onClick={undoDismiss} disabled={busy} label={`Undo dismissing ${undo.merchant}`}>Undo</ActionButton>
        </div>
      )}

      {/* Alerts at the top — most actionable */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          {alerts.map((a, idx) => {
            const colors = a.kind === "price_up"
              ? { bg: "rgba(232,85,85,.07)", border: "rgba(232,85,85,.2)", left: "#e85555", text: "#c89080" }
              : { bg: "rgba(240,160,48,.07)", border: "rgba(240,160,48,.2)", left: "#f0a030", text: "#c8a060" }
            return (
              <div key={idx} style={{
                background: colors.bg, border: `1px solid ${colors.border}`,
                borderLeft: `3px solid ${colors.left}`, borderRadius: 6,
                padding: "10px 14px", marginBottom: 6, fontSize: 12.5,
                color: colors.text, display: "flex", gap: 10, alignItems: "center",
              }}>
                <span style={{ fontSize: 14 }}>⚠</span>
                <span>{a.message}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Subscriptions */}
      <div style={card}>
        <div style={cardHead}>
          <div style={cardTitle}>Subscriptions</div>
          <div style={cardTotal}>{fmtInt(totals.monthlySubscriptions)}/mo</div>
        </div>
        {subscriptions.length === 0 ? (
          <div style={{ color: "#5a7a5a", fontSize: 13 }}>No subscriptions detected yet.</div>
        ) : subscriptions.map(s => <StreamRow key={rowKey(s)} s={s} actions={rowActions(s)} />)}
      </div>

      {/* Bills */}
      <div style={card}>
        <div style={cardHead}>
          <div style={cardTitle}>Bills</div>
          <div style={cardTotal}>{fmtInt(totals.monthlyBills)}/mo</div>
        </div>
        {bills.length === 0 ? (
          <div style={{ color: "#5a7a5a", fontSize: 13 }}>No bills detected yet.</div>
        ) : bills.map(s => <StreamRow key={rowKey(s)} s={s} actions={rowActions(s)} />)}
      </div>

      {/* Suggested: recurring charges to review, outside every total. */}
      {suggested && (
        <div style={card}>
          <div style={cardHead}>
            <div style={cardTitle}>Suggested</div>
            <div style={cardTotal}>not in totals</div>
          </div>
          <div style={{ color: "#5a7a5a", fontSize: 12, marginBottom: 6 }}>
            These repeat, but may not be subscriptions or bills. Confirm the ones that are; dismiss the rest.
          </div>
          {suggested.length === 0 ? (
            <div style={{ color: "#5a7a5a", fontSize: 13 }}>Nothing to review.</div>
          ) : suggested.map((s: SuggestedStream) => (
            <StreamRow
              key={rowKey(s)}
              s={s}
              chips={s.isNew && <span title="Plaid only just started seeing this" style={chip("#4ad6a0", "rgba(74,214,160,.12)", "rgba(74,214,160,.3)")}>New</span>}
              actions={<>
                <ActionButton onClick={() => confirm(s)} disabled={busy} label={`Confirm ${s.merchant}`}>Confirm</ActionButton>
                <ActionButton onClick={() => dismiss(s)} disabled={busy} label={`Dismiss ${s.merchant}`}>Dismiss</ActionButton>
                <span style={{ fontSize: 11, color: "#5a7a5a" }}>{s.confirmsAs === "bill" ? "Confirming adds it to Bills" : "Confirming adds it to Subscriptions"}</span>
              </>}
            />
          ))}
          {dismissed && dismissed.length > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary style={{ cursor: "pointer", fontSize: 12, color: "#8ab88a" }}>Dismissed ({dismissed.length})</summary>
              {dismissed.map((s) => (
                <StreamRow
                  key={rowKey(s)}
                  s={s}
                  showMark={false}
                  actions={s.mark ? (
                    <ActionButton onClick={() => removeVerdict(s.mark!.id)} disabled={busy} label={`Restore ${s.merchant}`}>Restore</ActionButton>
                  ) : undefined}
                />
              ))}
            </details>
          )}
        </div>
      )}

      {/* Upcoming */}
      <div style={card}>
        <div style={cardHead}>
          <div style={cardTitle}>Upcoming · next 14 days</div>
          <div style={cardTotal}>{upcoming.length} due</div>
        </div>
        {upcoming.length === 0 ? (
          <div style={{ color: "#5a7a5a", fontSize: 13 }}>Nothing due in the next two weeks.</div>
        ) : upcoming.map(s => <UpcomingRow key={s.key + (s.mark?.id ?? "")} s={s} />)}
      </div>
    </div>
  )
}