import React, { useState, useEffect, CSSProperties } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApiFetch } from './lib/useApiFetch'
import { MonthlyTotal } from './types'
import { API_URL } from "./config"
import { useSyncVersion } from "./SyncProvider"
import { periodProgress, usePeriod } from "./PeriodProvider"

// Spending per money period (M7.2), oldest first, including empty periods as
// zero. The window starts on a period boundary, so the oldest point is a full
// period (before M7.2 it was a partial month plotted as a low one). The newest
// point is in progress and is labelled "so far", never projected.

const styles: Record<string, CSSProperties | ((...args: any[]) => CSSProperties)> = {
  wrap:   { background: '#111', border: '1px solid #1e1e1e', borderRadius: 12, padding: '20px 24px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 20, gap: 12, flexWrap: 'wrap' },
  title:  { fontSize: '22px', fontWeight: 700, letterSpacing: '-0.5px', color: '#f0ede8' },
  sub:    { fontFamily: "'IBM Plex Mono', monospace", fontSize: '12px', color: '#555' },
  empty:  { textAlign: 'center', padding: '40px 0', color: '#555', fontFamily: "'IBM Plex Mono', monospace", fontSize: '13px' },
  delta:  (up: boolean) => ({
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: '11px',
    padding: '2px 8px',
    borderRadius: 4,
    background: up ? 'rgba(240,160,48,0.1)' : 'rgba(0,229,160,0.08)',
    color:      up ? '#f0a030'              : '#00e5a0',
    border:     `1px solid ${up ? 'rgba(240,160,48,0.25)' : 'rgba(0,229,160,0.2)'}`,
  }),
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload as MonthlyTotal
  const progress = periodProgress(point)
  return (
    <div style={{ background: '#161e14', border: '1px solid #253325', borderRadius: 6, padding: '8px 12px', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>
      <div style={{ color: '#555', marginBottom: 4 }}>{label}</div>
      {progress && <div style={{ color: '#f0a030', fontSize: 10.5, marginBottom: 4 }}>{progress}</div>}
      <div style={{ color: '#00e5a0' }}>${payload[0].value.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
      <div style={{ color: '#555', fontSize: 11 }}>{point.txCount} transactions</div>
    </div>
  )
}

export default function TrendChart() {
  const [data,    setData]    = useState<MonthlyTotal[]>([])
  const [loading, setLoading] = useState(true)
  const apiFetch = useApiFetch()
  const syncVersion = useSyncVersion()
  const { version: periodVersion } = usePeriod()

  // Re-runs after every sync and every period-setting change; the current chart
  // stays on screen meanwhile, and a superseded run's response is ignored.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/transactions/trends`)
        const d = await res.json()
        if (!cancelled) setData(d.trends ?? [])
      } catch (e) {
        console.error('TrendChart fetch failed:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [apiFetch, syncVersion, periodVersion])

  const noun = data.length > 0 && data[data.length - 1].startDay !== 1 ? 'period' : 'month'
  const current = data[data.length - 1]
  const progress = periodProgress(current)
  const periodsWithData = data.filter((p) => p.txCount > 0).length

  const delta = (() => {
    if (data.length < 2) return null
    const prev = data[data.length - 2].total
    const curr = data[data.length - 1].total
    if (prev === 0) return null
    const pct = ((curr - prev) / prev) * 100
    return { pct: Math.abs(pct).toFixed(1), up: pct > 0 }
  })()

  return (
    <div style={styles.wrap as CSSProperties}>
      <div style={styles.header as CSSProperties}>
        <span style={styles.title as CSSProperties}>Monthly Spending</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {delta && (
            <span style={(styles.delta as (up: boolean) => CSSProperties)(delta.up)}>
              {/* A partial period vs a full one: say so rather than let it read as a trend. */}
              {delta.up ? '▲' : '▼'} {delta.pct}% vs last {noun}{progress ? ` · ${progress}` : ''}
            </span>
          )}
          <span style={styles.sub as CSSProperties}>last {data.length} {noun}s</span>
        </div>
      </div>

      {loading && <div style={styles.empty as CSSProperties}>Loading...</div>}

      {!loading && periodsWithData < 2 && (
        <div style={styles.empty as CSSProperties}>Not enough data yet — need at least 2 {noun}s.</div>
      )}

      {!loading && periodsWithData >= 2 && (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#00e5a0" stopOpacity={0.18}/>
                <stop offset="95%" stopColor="#00e5a0" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
            <XAxis
              dataKey="label"
              tick={{ fill: '#555', fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }}
              axisLine={{ stroke: '#1a1a1a' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={v => `$${(v / 1000).toFixed(1)}k`}
              tick={{ fill: '#555', fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="total"
              stroke="#00e5a0"
              strokeWidth={2}
              fill="url(#greenGrad)"
              dot={(props: any) => {
                const { cx, cy, payload, index } = props
                // The in-progress period gets a hollow dot: a partial total.
                return payload?.inProgress
                  ? <circle key={`dot-${index}`} cx={cx} cy={cy} r={3.5} fill="#111" stroke="#00e5a0" strokeWidth={1.5} />
                  : <circle key={`dot-${index}`} cx={cx} cy={cy} r={3} fill="#00e5a0" />
              }}
              activeDot={{ r: 5, fill: '#00e5a0' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
