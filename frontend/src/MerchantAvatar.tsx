import React, { useState } from "react"

interface Props { name: string; logoUrl: string | null; color?: string; size?: number }

// Stable color pick from merchant name (so fallback avatars don't flicker on re-render)
const PALETTE = ["#ff7a6b", "#00a856", "#4a9eff", "#f0a030", "#a855f7", "#ec4899", "#06b6d4"]
function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export default function MerchantAvatar({ name, logoUrl, size = 32 }: Props) {
  const [failed, setFailed] = useState(false)
  const initial = (name[0] ?? "?").toUpperCase()
  const bg = colorFor(name)

  if (!logoUrl || failed) {
    return (
      <div style={{
        width: size, height: size, borderRadius: "50%",
        background: bg + "33",            // alpha ~20%
        color: bg,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: Math.round(size * 0.4),
        fontWeight: 600, flexShrink: 0,
      }}>{initial}</div>
    )
  }

  return (
    <img
      src={logoUrl}
      alt={name}
      onError={() => setFailed(true)}
      style={{
        width: size, height: size, borderRadius: "50%",
        objectFit: "cover",
        background: "#0d1510",
        flexShrink: 0,
      }}
    />
  )
}