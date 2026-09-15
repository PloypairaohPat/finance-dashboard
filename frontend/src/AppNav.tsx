import { NavLink } from "react-router-dom"
import useMediaQuery from "./useMediaQuery"
import { TABS } from "./tabs"
import { colors, fonts } from "./tokens"

// ─────────────────────────────────────────────────────────────────
//  AppNav — the five top-level tabs.
//
//  Desktop: a tab bar directly under the app header. Mobile (≤640px, the
//  breakpoint used everywhere else): a bar fixed to the bottom of the screen.
//
//  Built from tabs.ts, the same list <Routes> in App.tsx is built from, so a
//  tab can't exist in one and not the other. The active tab comes from the
//  router via NavLink (which also sets aria-current="page"); Overview uses
//  `end` so it isn't active on every route.
//
//  Links point at bare paths and know nothing about demo mode: a click drops
//  the query string and DemoUrlSync puts `?demo=1` back. Verified by
//  scripts/url-params-repro/link-nav-check.mjs.
//
//  Styling follows AppHeader (surface #0d0d0d, border #222) and tokens.ts for
//  type, text colours and the accent (colors.green, which the header, nav and
//  bell all use since the M7.2 run replaced a second, near-identical green).
// ─────────────────────────────────────────────────────────────────

const HEADER_BG = "#0d0d0d"
const HEADER_BORDER = "#222"
const ACCENT = colors.green
const BOTTOM_BAR_HEIGHT = 56

const css = `
.ledger-nav-link {
  color: ${colors.muted};
  text-decoration: none;
  font-family: ${fonts.mono};
  transition: color .15s ease, border-color .15s ease;
}
.ledger-nav-link:hover { color: ${colors.muted2}; }
.ledger-nav-link.active { color: ${colors.textHi}; }
.ledger-nav-link:focus-visible { outline: 1px solid ${ACCENT}; outline-offset: 2px; }

.ledger-nav-top {
  display: inline-block;
  padding: 14px 0 12px;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
}
.ledger-nav-top.active { border-bottom-color: ${ACCENT}; }

.ledger-nav-bottom {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: ${BOTTOM_BAR_HEIGHT}px;
  font-size: 10px;
  letter-spacing: .04em;
}
.ledger-nav-bottom.active::before {
  content: "";
  position: absolute;
  top: 0; left: 28%; right: 28%;
  height: 2px;
  background: ${ACCENT};
}
.ledger-nav-bottom .ledger-nav-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 2px;
}

/* Keep page content clear of the fixed bottom bar. */
@media (max-width: 640px) {
  body { padding-bottom: calc(${BOTTOM_BAR_HEIGHT + 1}px + env(safe-area-inset-bottom)); }
}
`

const iconProps = {
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const, "aria-hidden": true,
}

function TabIcon({ id }: { id: string }) {
  switch (id) {
    case "overview":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
        </svg>
      )
    case "accounts":
      return (
        <svg {...iconProps}>
          <path d="M3 9.5 12 4l9 5.5" />
          <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" />
          <path d="M3 20.5h18" />
        </svg>
      )
    case "budgets":
      return (
        <svg {...iconProps}>
          <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12Z" />
          <path d="M15 3.9A8.5 8.5 0 0 1 20.1 9H15Z" />
        </svg>
      )
    case "transactions":
      return (
        <svg {...iconProps}>
          <path d="M4 7h13M14 4l3 3-3 3" />
          <path d="M20 17H7M10 14l-3 3 3 3" />
        </svg>
      )
    case "subscriptions":
      return (
        <svg {...iconProps}>
          <path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L20 9.5" />
          <path d="M20 4.5v5h-5" />
          <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1L4 14.5" />
          <path d="M4 19.5v-5h5" />
        </svg>
      )
    default:
      return <svg {...iconProps}><circle cx="12" cy="12" r="3" /></svg>
  }
}

export default function AppNav() {
  const isMobile = useMediaQuery("(max-width: 640px)")

  if (isMobile) {
    return (
      <>
        <style>{css}</style>
        <nav aria-label="Primary" style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 900,
          background: HEADER_BG, borderTop: `1px solid ${HEADER_BORDER}`,
          paddingBottom: "env(safe-area-inset-bottom)",
        }}>
          <ul style={{
            display: "grid", gridTemplateColumns: `repeat(${TABS.length}, 1fr)`,
            margin: 0, padding: 0, listStyle: "none",
          }}>
            {TABS.map((tab) => (
              <li key={tab.id} style={{ minWidth: 0 }}>
                <NavLink to={tab.path} end={tab.path === "/"} className="ledger-nav-link ledger-nav-bottom">
                  <TabIcon id={tab.id} />
                  <span className="ledger-nav-label">{tab.shortLabel ?? tab.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </>
    )
  }

  return (
    <>
      <style>{css}</style>
      <nav aria-label="Primary" style={{
        background: HEADER_BG, borderBottom: `1px solid ${HEADER_BORDER}`,
        padding: "0 40px", overflowX: "auto",
      }}>
        <ul style={{ display: "flex", gap: 28, margin: 0, padding: 0, listStyle: "none" }}>
          {TABS.map((tab) => (
            <li key={tab.id}>
              <NavLink to={tab.path} end={tab.path === "/"} className="ledger-nav-link ledger-nav-top">
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}
