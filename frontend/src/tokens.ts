// M5.10 — Single source of truth for visual design tokens.
// Use these in any new component. Existing components can be migrated
// opportunistically; no need for a sweeping refactor.

export const colors = {
  // Surfaces
  bg:        "#0a0f0c",
  surface:   "#111710",
  surface2:  "#161e14",
  surface3:  "#0d1510",     // chart background, input bg
  border:    "#1e2b1e",
  border2:   "#253325",

  // Text
  text:      "#d4e8d4",
  textHi:    "#e8f4e8",     // for serif headers, hero values
  muted:     "#5a7a5a",
  muted2:    "#8ab88a",     // muted but readable

  // Semantic
  green:     "#00e87a",
  greenDim:  "#00a856",
  amber:     "#f0a030",
  red:       "#e85555",
  blue:      "#4a9eff",
  coral:     "#ff7a6b",
  purple:    "#a855f7",

  // Backgrounds for callouts/alerts
  greenBg:   "rgba(0,232,122,0.07)",
  amberBg:   "rgba(240,160,48,0.08)",
  redBg:     "rgba(232,85,85,0.07)",
  blueBg:    "rgba(74,158,255,0.07)",
  coralBg:   "rgba(255,122,107,0.07)",
} as const

export const fonts = {
  mono:      "'IBM Plex Mono', monospace",
  serif:     "'Fraunces', Georgia, serif",
  sans:      "'DM Sans', system-ui, sans-serif",
} as const

export const fontSize = {
  micro:     "9px",         // mono labels in stat boxes
  caption:   "10px",        // mono labels in card heads
  small:     "11px",
  body:      "13px",
  bodyLg:    "13.5px",
  h3:        "16px",        // section titles inside cards
  h2:        "18px",        // section card heads
  h1:        "26px",        // hero numbers
  display:   "32px",        // runway hero
} as const

export const radius = {
  sm:        "4px",
  md:        "6px",
  lg:        "8px",
  xl:        "10px",
  pill:      "20px",
} as const

export const space = {
  xs:        "4px",
  sm:        "8px",
  md:        "12px",
  lg:        "16px",
  xl:        "20px",
  xxl:       "24px",
  section:   "32px",
} as const

export const motion = {
  fast:      ".15s ease",   // hover states, button feedback
  medium:    ".3s ease",    // bar fills, chart updates
  slow:      ".6s ease",    // dial reveal on first paint
} as const

// Convenience: card style preset (most common pattern in the app)
export const card = {
  background: colors.surface2,
  border:     `1px solid ${colors.border2}`,
  borderRadius: radius.xl,
  padding:    "20px",
} as const

// Convenience: section title preset
export const sectionTitle = {
  fontFamily: fonts.serif,
  fontWeight: 300,
  fontSize:   fontSize.h2,
  color:      colors.textHi,
  marginBottom: "16px",
} as const