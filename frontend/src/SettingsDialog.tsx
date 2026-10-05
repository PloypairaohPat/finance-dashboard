import { useEffect, useId, useRef, useState } from "react"
import { useClerk } from "@clerk/clerk-react"
import { useSettings } from "./SettingsProvider"
import { colors, fonts } from "./tokens"
import { API_URL } from "./config"
import { useApiFetch } from "./lib/useApiFetch"
import { readWriteResult } from "./lib/writeResult"
import { backupSentence, logSentence } from "./lib/retention"

/** Mirrors the server's DELETE_CONFIRMATION; the server checks it again. */
const DELETE_CONFIRMATION = "delete my data"

// ─────────────────────────────────────────────────────────────────
//  SettingsDialog — opened from "Settings" in the account menu (M7.2).
//
//  Two controls: the day money periods start on (M7.2), and whether money in
//  through a payment app counts as income (M7.3). Below them, "Delete account
//  and all data". It is not a settings page;
//  it lives behind the account menu because both settings reach the hero,
//  Insights and five charts, not one chart's header.
//
//  Signed-in users only: demo mode is fixed at day 1 and never shows it.
// ─────────────────────────────────────────────────────────────────

const ordinal = (n: number) => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`
}

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1)

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { startDay, paymentAppInflowsAreIncome, loaded, save } = useSettings()
  const [choice, setChoice] = useState(startDay)
  const [asIncome, setAsIncome] = useState(paymentAppInflowsAreIncome)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const titleId = useId()
  const selectId = useId()

  // Adopt the stored values if they finish loading after the dialog opened.
  useEffect(() => { setChoice(startDay) }, [startDay])
  useEffect(() => { setAsIncome(paymentAppInflowsAreIncome) }, [paymentAppInflowsAreIncome])

  useEffect(() => {
    selectRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const onSave = async () => {
    setSaving(true)
    setError(null)
    const message = await save({ startDay: choice, paymentAppInflowsAreIncome: asIncome })
    setSaving(false)
    if (message) setError(message)
    else onClose()
  }

  const unchanged = choice === startDay && asIncome === paymentAppInflowsAreIncome

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,.55)" }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "fixed", zIndex: 1000,
          top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "min(440px, calc(100vw - 32px))",
          // Taller than a phone screen with the delete section: scroll inside.
          maxHeight: "calc(100vh - 32px)", overflowY: "auto", boxSizing: "border-box",
          background: "#0d0d0d", border: "1px solid #222", borderRadius: 10,
          padding: 24, color: colors.text, fontFamily: fonts.sans,
        }}
      >
        <h2 id={titleId} style={{
          margin: "0 0 18px", fontFamily: fonts.serif, fontWeight: 300,
          fontSize: 22, color: colors.textHi,
        }}>Settings</h2>

        <label htmlFor={selectId} style={{
          display: "block", fontFamily: fonts.mono, fontSize: 11,
          letterSpacing: ".06em", textTransform: "uppercase", color: colors.muted, marginBottom: 8,
        }}>
          Money periods start on
        </label>
        <select
          id={selectId}
          ref={selectRef}
          value={choice}
          disabled={!loaded || saving}
          onChange={(e) => setChoice(Number(e.target.value))}
          style={{
            width: "100%", padding: "10px 12px", borderRadius: 6,
            background: colors.surface3, color: colors.textHi,
            border: `1px solid ${colors.border2}`, fontFamily: fonts.mono, fontSize: 13,
          }}
        >
          {DAYS.map((day) => (
            <option key={day} value={day}>
              {day === 1 ? "The 1st (calendar months)" : `The ${ordinal(day)} of each month`}
            </option>
          ))}
        </select>

        <p style={{ fontSize: 13, lineHeight: 1.6, color: colors.muted2, margin: "14px 0 0" }}>
          Cash flow, Monthly savings, Monthly Spending, Month over month, Insights and the
          Overview&rsquo;s saved figure group your money into periods that start on this day
          &mdash; useful if rent or a paycheck lands early in the month. Net worth marks where
          each period starts.
        </p>
        <p style={{ fontSize: 12, lineHeight: 1.6, color: colors.muted, margin: "8px 0 0" }}>
          Budgets, the financial score, goals and alerts still use calendar months.
        </p>

        <div style={{ borderTop: `1px solid ${colors.border2}`, margin: "20px 0 0", paddingTop: 18 }}>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={asIncome}
              disabled={!loaded || saving}
              onChange={(e) => setAsIncome(e.target.checked)}
              style={{ marginTop: 3, accentColor: colors.green, width: 15, height: 15 }}
            />
            <span>
              <span style={{
                display: "block", fontFamily: fonts.mono, fontSize: 11,
                letterSpacing: ".06em", textTransform: "uppercase", color: colors.muted, marginBottom: 6,
              }}>
                Count money from payment apps as income
              </span>
              <span style={{ fontSize: 13, lineHeight: 1.6, color: colors.muted2 }}>
                Money in through Venmo, Zelle or Cash App is normally treated as someone paying
                you back, so it reduces what you paid out rather than counting as income. Turn
                this on if people usually send you money that is really yours to keep &mdash; a
                roommate&rsquo;s share of the rent, or work paid this way.
              </span>
            </span>
          </label>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: colors.muted, margin: "10px 0 0 25px" }}>
            This changes what every period has always meant, not just from now on, so your income,
            savings rate and score move for past months too. Payments you send stay under
            &ldquo;Payments to people&rdquo;, at their full amount.
          </p>
        </div>

        {error && (
          <div role="alert" style={{ marginTop: 14, fontFamily: fonts.mono, fontSize: 12, color: colors.red }}>
            ⚠ {error}
          </div>
        )}

        <DeleteAccount />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{
            background: "transparent", border: "1px solid #333", color: "#888",
            padding: "8px 16px", borderRadius: 4, cursor: "pointer",
            fontFamily: fonts.mono, fontSize: 12,
          }}>Cancel</button>
          <button
            onClick={onSave}
            disabled={!loaded || saving || unchanged}
            style={{
              background: unchanged || saving ? "#1a2e20" : colors.green,
              color: unchanged || saving ? "#00e87a80" : "#000",
              border: "none", padding: "8px 18px", borderRadius: 4,
              cursor: !loaded || saving || unchanged ? "not-allowed" : "pointer",
              fontFamily: fonts.mono, fontSize: 12, fontWeight: 600,
            }}
          >{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </>
  )
}

// ── "Delete account and all data" ─────────────────────────────────
//
// The phrase is checked here only to enable the button; the server checks it
// again (DELETE /user). Afterwards the user is signed out: their Clerk account
// is gone, or banned if its removal is still pending.

function DeleteAccount() {
  const apiFetch = useApiFetch()
  const { signOut } = useClerk()
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputId = useId()
  const ready = typed.trim().toLowerCase() === DELETE_CONFIRMATION

  const onDelete = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await apiFetch(`${API_URL}/user`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: typed }),
      })
      const result = await readWriteResult(res)
      if (!result.ok) { setMessage(result.message); return }
      const body = result.data as { accountDeleted?: boolean; message?: string } | null
      if (body?.accountDeleted === false && body.message) setMessage(body.message)
      await signOut({ redirectUrl: "/" })
    } catch (e: any) {
      setMessage(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ borderTop: `1px solid ${colors.border2}`, margin: "20px 0 0", paddingTop: 18 }}>
      <div style={{
        fontFamily: fonts.mono, fontSize: 11, letterSpacing: ".06em",
        textTransform: "uppercase", color: colors.red, marginBottom: 8,
      }}>
        Delete account and all data
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: colors.muted2, margin: 0 }}>
        Disconnects every bank (Plaid loses access to your accounts), then permanently deletes
        your transactions, balances, budgets, goals, alerts and settings, and your sign-in
        account. It can&rsquo;t be undone.
      </p>
      <p style={{ fontSize: 12, lineHeight: 1.6, color: colors.muted, margin: "8px 0 0" }}>
        {backupSentence()} {logSentence()} Plaid keeps its own records under its own policy.
      </p>
      <label htmlFor={inputId} style={{ display: "block", fontSize: 12, color: colors.muted2, margin: "12px 0 6px" }}>
        Type <span style={{ fontFamily: fonts.mono, color: colors.textHi }}>{DELETE_CONFIRMATION}</span> to confirm
      </label>
      <input
        id={inputId}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        style={{
          width: "100%", padding: "9px 12px", borderRadius: 6, boxSizing: "border-box",
          background: colors.surface3, color: colors.textHi,
          border: `1px solid ${colors.border2}`, fontFamily: fonts.mono, fontSize: 13,
        }}
      />
      <button
        onClick={onDelete}
        disabled={!ready || busy}
        style={{
          width: "100%", marginTop: 10, padding: "9px 14px", borderRadius: 4,
          background: ready && !busy ? colors.red : "transparent",
          color: ready && !busy ? "#000" : colors.red,
          border: `1px solid ${colors.red}`,
          cursor: ready && !busy ? "pointer" : "not-allowed",
          fontFamily: fonts.mono, fontSize: 12, fontWeight: 600,
        }}
      >{busy ? "Deleting…" : "Delete account and all data"}</button>
      {message && (
        <div role="alert" style={{ marginTop: 10, fontFamily: fonts.mono, fontSize: 12, color: colors.red, lineHeight: 1.5 }}>
          ⚠ {message}
        </div>
      )}
    </div>
  )
}
