import React, { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { API_URL } from "./config"
import type { EnrichedGoal, GoalType, GoalStatus, Account } from "./types"

const TYPE_META: Record<GoalType, { icon: string; color: string; label: string }> = {
  emergency_fund: { icon: "🛡", color: "#00e87a", label: "Emergency fund" },
  savings:        { icon: "🏠", color: "#a855f7", label: "Savings" },
  vacation:       { icon: "✈", color: "#4a9eff", label: "Vacation" },
  debt_payoff:    { icon: "💳", color: "#e85555", label: "Debt payoff" },
}
const STATUS_COLOR: Record<GoalStatus, string> = {
  on_track: "#00a856", ahead: "#00a856", behind: "#f0a030",
  complete: "#00e87a", new: "#5a7a5a",
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export default function GoalsCard() {
  const { getToken, isSignedIn } = useAuth()
  const [goals, setGoals] = useState<EnrichedGoal[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [adding, setAdding] = useState(false)
  const [type, setType] = useState<GoalType>("savings")
  const [name, setName] = useState("")
  const [target, setTarget] = useState("")
  const [deadline, setDeadline] = useState("")
  const [accountId, setAccountId] = useState("")
  const [months, setMonths] = useState("6")
  const [error, setError] = useState<string | null>(null)

  const reload = async () => {
    const token = await getToken()
    const [g, a] = await Promise.all([
      fetch(`${API_URL}/goals`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`${API_URL}/accounts`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ])
    setGoals(Array.isArray(g) ? g : [])
    setAccounts(Array.isArray(a) ? a : (a.accounts ?? []))
  }

  useEffect(() => { if (isSignedIn) reload() }, [isSignedIn])  // eslint-disable-line

  const resetForm = () => {
    setAdding(false); setError(null)
    setType("savings"); setName(""); setTarget("")
    setDeadline(""); setAccountId(""); setMonths("6")
  }

  const submit = async () => {
    setError(null)
    const token = await getToken()
    const body: any = { type, name: name.trim() }
    if (type !== "emergency_fund" && type !== "debt_payoff") body.targetAmount = Number(target) || 0
    if (type === "vacation") body.deadline = deadline
    if (type === "debt_payoff" || accountId) body.accountId = accountId
    if (type === "emergency_fund") body.data = { months: Number(months) || 6 }

    const res = await fetch(`${API_URL}/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to save" }))
      setError(err.error || "Failed to save")
      return
    }
    await reload()
    resetForm()
  }

  const remove = async (id: string) => {
    const token = await getToken()
    await fetch(`${API_URL}/goals/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    setGoals(prev => prev.filter(g => g.id !== id))
  }

  const creditLoanAccounts = accounts.filter(a => a.type === "credit" || a.type === "loan")
  const depositoryAccounts = accounts.filter(a => a.type === "depository")

  return (
    <div>
      {goals.length === 0 && !adding && (
        <div style={{ color: "#5a7a5a", fontSize: 13, marginBottom: 14 }}>
          Start with an emergency fund.
        </div>
      )}

      {goals.map(g => {
        const meta = TYPE_META[g.type]
        const fillColor = g.status === "behind" ? "#f0a030"
          : g.status === "complete" ? "#00e87a"
          : "#00a856"
        return (
          <div key={g.id} className="interactive-row" style={{
            display: "grid",
            gridTemplateColumns: "36px 1fr auto",
            gap: 14, padding: "12px 0",
            borderBottom: "1px solid #1e2b1e",
            alignItems: "center",
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: meta.color + "20", color: meta.color,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, flexShrink: 0,
            }}>{meta.icon}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                display: "flex", alignItems: "baseline", gap: 8,
                marginBottom: 5,
              }}>
                <span style={{ fontSize: 13.5, color: "#d4e8d4", fontWeight: 500 }}>{g.name}</span>
                <span onClick={() => remove(g.id)} style={{
                  fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                  color: "#5a7a5a", cursor: "pointer", marginLeft: "auto",
                }} onMouseEnter={e => { e.currentTarget.style.color = "#e85555" }}
                   onMouseLeave={e => { e.currentTarget.style.color = "#5a7a5a" }}>
                  delete
                </span>
              </div>
              <div style={{
                height: 5, background: "#0d1510", borderRadius: 3,
                overflow: "hidden", marginBottom: 4,
              }}>
                <div style={{
                  width: `${g.progressPct}%`, height: "100%",
                  background: fillColor, borderRadius: 3, transition: "width .4s",
                }} />
              </div>
              <div style={{
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                color: "#5a7a5a", display: "flex", gap: 10, flexWrap: "wrap",
              }}>
                <span>{fmt(g.currentAmount)} / {fmt(g.targetAmount ?? 0)}</span>
                {g.hint && (
                  <span style={{ color: STATUS_COLOR[g.status] }}>{g.hint}</span>
                )}
              </div>
            </div>
            <div style={{
              fontFamily: "Fraunces, Georgia, serif", fontSize: 16,
              color: "#e8f4e8", minWidth: 54, textAlign: "right",
            }}>{Math.round(g.progressPct)}%</div>
          </div>
        )
      })}

      {!adding ? (
        <button onClick={() => setAdding(true)} style={{
          marginTop: 16, width: "100%",
          background: "transparent", border: "1px dashed #253325",
          color: "#5a7a5a", padding: "10px 14px", borderRadius: 8,
          cursor: "pointer", fontFamily: "IBM Plex Mono, monospace",
          fontSize: 11, letterSpacing: ".04em",
        }}>+ Add a goal</button>
      ) : (
        <div style={{
          marginTop: 16, background: "#0d1510",
          border: "1px solid #253325", borderRadius: 8, padding: 14,
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          {/* Type pills */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
            {(["savings", "emergency_fund", "vacation", "debt_payoff"] as GoalType[]).map(t => (
              <button key={t} onClick={() => setType(t)} style={{
                fontFamily: "IBM Plex Mono, monospace", fontSize: 10,
                padding: "5px 10px", borderRadius: 12,
                border: "1px solid " + (type === t ? "#ff7a6b" : "#253325"),
                background: type === t ? "#ff7a6b" : "transparent",
                color: type === t ? "#000" : "#5a7a5a",
                cursor: "pointer", letterSpacing: ".04em",
              }}>{TYPE_META[t].label}</button>
            ))}
          </div>

          <input placeholder="Name" value={name} onChange={e => setName(e.target.value)}
            style={{ background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
              padding: "7px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5 }} />

          {type !== "emergency_fund" && type !== "debt_payoff" && (
            <input type="number" placeholder="Target amount" value={target}
              onChange={e => setTarget(e.target.value)}
              style={{ background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "7px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5 }} />
          )}

          {type === "vacation" && (
            <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
              style={{ background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "7px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5 }} />
          )}

          {type === "emergency_fund" && (
            <input type="number" placeholder="Months of expenses (default 6)" value={months}
              onChange={e => setMonths(e.target.value)}
              style={{ background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "7px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5 }} />
          )}

          {type === "debt_payoff" && (
            <select value={accountId} onChange={e => setAccountId(e.target.value)}
              style={{ background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "7px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5 }}>
              <option value="">Select credit/loan account…</option>
              {creditLoanAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}

          {(type === "savings" || type === "vacation") && depositoryAccounts.length > 0 && (
            <select value={accountId} onChange={e => setAccountId(e.target.value)}
              style={{ background: "#161e14", border: "1px solid #253325", color: "#d4e8d4",
                padding: "7px 10px", borderRadius: 6, fontFamily: "inherit", fontSize: 12.5 }}>
              <option value="">Track manually (no account link)</option>
              {depositoryAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}

          {error && (
            <div style={{ color: "#e85555", fontSize: 11, fontFamily: "IBM Plex Mono, monospace" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={submit} disabled={!name} style={{
              background: "#ff7a6b", color: "#000", border: "none",
              padding: "7px 16px", borderRadius: 6, cursor: name ? "pointer" : "default",
              fontFamily: "IBM Plex Mono, monospace", fontSize: 11, fontWeight: 600,
              opacity: name ? 1 : .4,
            }}>Create</button>
            <button onClick={resetForm} style={{
              background: "transparent", color: "#5a7a5a", border: "1px solid #253325",
              padding: "7px 16px", borderRadius: 6, cursor: "pointer",
              fontFamily: "IBM Plex Mono, monospace", fontSize: 11,
            }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
