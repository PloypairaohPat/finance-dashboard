import React, { useCallback, useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { usePlaidLink, PlaidLinkError } from "react-plaid-link"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { useDemo } from "./lib/DemoContext"
import type { PlaidItemStatus, PlaidItemSummary } from "./types"

const STATUS_META: Record<PlaidItemStatus, { dot: string; message: string | null; reconnect: boolean }> = {
  healthy:             { dot: "#00e87a", message: null, reconnect: false },
  pending_expiration:  { dot: "#f0a030", message: "Reconnect soon — this connection expires shortly", reconnect: true },
  login_required:      { dot: "#e85555", message: "Reconnect needed — your bank needs you to sign in again", reconnect: true },
  revoked:             { dot: "#e85555", message: "Access revoked — reconnect to resume syncing", reconnect: true },
  error:               { dot: "#f0a030", message: "Sync problem — try reconnecting", reconnect: true },
}

const fmtRelative = (iso: string | null): string => {
  if (!iso) return "never synced"
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)

  if (m < 1) return "synced just now"
  if (m < 60) return `synced ${m}m ago`

  const h = Math.floor(m / 60)
  if (h < 24) return `synced ${h}h ago`

  const d = Math.floor(h / 24)
  return `synced ${d}d ago`
}

export default function ConnectedBanks() {
  const { isSignedIn } = useAuth()
  const apiFetch = useApiFetch()
  const { demoMode } = useDemo()

  const [items, setItems] = useState<PlaidItemSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [reconnectingId, setReconnectingId] = useState<string | null>(null)
  const [updateLinkToken, setUpdateLinkToken] = useState<string | null>(null)

  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/plaid-items`)
      if (res.ok) setItems(await res.json())
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => {
    if (!demoMode && !isSignedIn) return
    reload()
  }, [demoMode, isSignedIn, reload])

  // ── Reconnect (update-mode Plaid Link) — same pattern as App.tsx's
  // "⚡ Live Balances" flow, scoped to a specific item via itemId. ──────
  const onUpdateSuccess = useCallback(async () => {
    setUpdateLinkToken(null)
    setReconnectingId(null)
    await reload()
  }, [reload])

  const { open: openUpdate, ready: readyUpdate } = usePlaidLink({
    token: updateLinkToken,
    onSuccess: onUpdateSuccess,
    onExit: (err: PlaidLinkError | null) => {
      setUpdateLinkToken(null)
      setReconnectingId(null)
      if (err) setError("Reconnect exited with an error")
    },
  })

  useEffect(() => {
    if (updateLinkToken && readyUpdate) openUpdate()
  }, [updateLinkToken, readyUpdate, openUpdate])

  const startReconnect = async (itemId: string) => {
    setError(null)
    setReconnectingId(itemId)
    try {
      const res = await apiFetch(`${API_URL}/create-update-link-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      })
      const data = await res.json() as { link_token: string; error?: string }
      if (data.error) throw new Error(data.error)
      setUpdateLinkToken(data.link_token)
    } catch (e: any) {
      console.error("Reconnect failed:", e.message)
      setError(`Reconnect failed: ${e.message}`)
      setReconnectingId(null)
    }
  }

  // ── Disconnect ──────────────────────────────────────────────────
  const disconnect = async (itemId: string) => {
    setError(null)
    setDisconnectingId(itemId)
    try {
      const res = await apiFetch(`${API_URL}/plaid-items/${itemId}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to disconnect" }))
        throw new Error(data.error || "Failed to disconnect")
      }
      setConfirmingId(null)
      await reload()
    } catch (e: any) {
      console.error("Disconnect failed:", e.message)
      setError(`Disconnect failed: ${e.message}`)
    } finally {
      setDisconnectingId(null)
    }
  }

  if (loading) return null
  if (items.length === 0) return null

  return (
    <div>
      {error && (
        <div style={{
          color: "#c89080", fontSize: 12.5, marginBottom: 12,
          background: "rgba(232,85,85,.07)", border: "1px solid rgba(232,85,85,.2)",
          borderRadius: 6, padding: "8px 12px",
        }}>
          ⚠ {error}
        </div>
      )}

      {items.map((item) => {
        const meta = STATUS_META[item.status] ?? STATUS_META.error
        const isReconnecting = reconnectingId === item.id
        const isConfirming = confirmingId === item.id
        const isDisconnecting = disconnectingId === item.id

        return (
          <div key={item.id} style={{
            background: "#161e14", border: "1px solid #253325", borderRadius: 8,
            padding: "14px 16px", marginBottom: 10,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: meta.dot, flexShrink: 0,
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "#e8f4e8", fontSize: 14, fontWeight: 500 }}>
                  {item.institutionName ?? "Unknown institution"}
                </div>
                <div style={{
                  color: "#5a7a5a", fontSize: 12, marginTop: 2,
                  fontFamily: "IBM Plex Mono, monospace",
                }}>
                  {item.accountCount} account{item.accountCount === 1 ? "" : "s"} · {fmtRelative(item.lastSyncedAt)}
                </div>
              </div>

              {meta.reconnect && !isConfirming && (
                <button
                  onClick={() => startReconnect(item.id)}
                  disabled={isReconnecting}
                  style={{
                    background: "transparent", border: "1px solid #f0a03050",
                    color: "#f0a030", borderRadius: 6, padding: "6px 12px",
                    fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
                    letterSpacing: ".04em", cursor: isReconnecting ? "not-allowed" : "pointer",
                    opacity: isReconnecting ? 0.6 : 1, flexShrink: 0,
                  }}
                >
                  {isReconnecting ? "opening…" : "Reconnect"}
                </button>
              )}

              {!isConfirming && (
                <button
                  onClick={() => setConfirmingId(item.id)}
                  style={{
                    background: "transparent", border: "none",
                    color: "#5a7a5a", opacity: .6, cursor: "pointer",
                    fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
                    letterSpacing: ".04em", padding: "6px 4px", flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = "1" }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = ".6" }}
                >
                  Disconnect
                </button>
              )}
            </div>

            {meta.message && !isConfirming && (
              <div style={{ color: meta.dot, fontSize: 12.5, marginTop: 8, marginLeft: 20 }}>
                {meta.message}
              </div>
            )}

            {isConfirming && (
              <div style={{
                marginTop: 12, paddingTop: 12, borderTop: "1px dashed #253325",
                display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
              }}>
                <span style={{ color: "#c89080", fontSize: 12.5, flex: 1, minWidth: 200 }}>
                  This permanently deletes {item.institutionName ?? "this bank"}'s transaction history from the app. Continue?
                </span>
                <button
                  onClick={() => disconnect(item.id)}
                  disabled={isDisconnecting}
                  style={{
                    background: "#e8555520", border: "1px solid #e8555560",
                    color: "#e85555", borderRadius: 6, padding: "6px 12px",
                    fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
                    letterSpacing: ".04em", cursor: isDisconnecting ? "not-allowed" : "pointer",
                    opacity: isDisconnecting ? 0.6 : 1,
                  }}
                >
                  {isDisconnecting ? "disconnecting…" : "Yes, disconnect"}
                </button>
                <button
                  onClick={() => setConfirmingId(null)}
                  disabled={isDisconnecting}
                  style={{
                    background: "transparent", border: "1px solid #253325",
                    color: "#5a7a5a", borderRadius: 6, padding: "6px 12px",
                    fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
                    letterSpacing: ".04em", cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
