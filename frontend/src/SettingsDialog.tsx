import { useEffect, useId, useRef, useState } from "react"
import { usePeriod } from "./PeriodProvider"
import { colors, fonts } from "./tokens"

// ─────────────────────────────────────────────────────────────────
//  SettingsDialog — opened from "Settings" in the account menu (M7.2).
//
//  Holds exactly one control today: the day money periods start on. It is not
//  a settings page; it lives behind the account menu because the setting
//  reaches the hero, Insights and five charts, not one chart's header.
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
  const { startDay, loaded, save } = usePeriod()
  const [choice, setChoice] = useState(startDay)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const titleId = useId()
  const selectId = useId()

  // Adopt the stored value if it finishes loading after the dialog opened.
  useEffect(() => { setChoice(startDay) }, [startDay])

  useEffect(() => {
    selectRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const onSave = async () => {
    setSaving(true)
    setError(null)
    const message = await save(choice)
    setSaving(false)
    if (message) setError(message)
    else onClose()
  }

  const unchanged = choice === startDay

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

        {error && (
          <div role="alert" style={{ marginTop: 14, fontFamily: fonts.mono, fontSize: 12, color: colors.red }}>
            ⚠ {error}
          </div>
        )}

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
