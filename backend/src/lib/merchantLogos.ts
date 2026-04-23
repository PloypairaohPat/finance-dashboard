// Resolve a merchant name to a logo URL via Clearbit.
// Returns null when we can't confidently derive a domain — frontend
// falls back to an initial-circle avatar in that case.

const KNOWN: Record<string, string> = {
  "amazon": "amazon.com",
  "whole foods": "wholefoodsmarket.com",
  "whole foods market": "wholefoodsmarket.com",
  "trader joe's": "traderjoes.com",
  "trader joes": "traderjoes.com",
  "costco": "costco.com",
  "target": "target.com",
  "walmart": "walmart.com",
  "cvs": "cvs.com",
  "walgreens": "walgreens.com",
  "shell": "shell.com",
  "chevron": "chevron.com",
  "exxon": "exxon.com",
  "starbucks": "starbucks.com",
  "chipotle": "chipotle.com",
  "mcdonald's": "mcdonalds.com",
  "netflix": "netflix.com",
  "spotify": "spotify.com",
  "hulu": "hulu.com",
  "disney+": "disneyplus.com",
  "disney plus": "disneyplus.com",
  "uber": "uber.com",
  "lyft": "lyft.com",
  "doordash": "doordash.com",
  "grubhub": "grubhub.com",
  "apple": "apple.com",
  "icloud": "apple.com",
  "google": "google.com",
  "paypal": "paypal.com",
  "venmo": "venmo.com",
  "comcast": "xfinity.com",
  "xfinity": "xfinity.com",
  "pg&e": "pge.com",
  "at&t": "att.com",
  "verizon": "verizon.com",
  "t-mobile": "t-mobile.com",
  "chatgpt plus": "openai.com",
  "openai": "openai.com",
}

const normalize = (s: string) => s
  .toLowerCase()
  .replace(/\s+#\d+.*$/, "")     // strip store numbers
  .replace(/\s{2,}/g, " ")
  .trim()

function resolveDomain(merchant: string): string | null {
  const n = normalize(merchant)
  if (KNOWN[n]) return KNOWN[n]

  // Partial match — handles "AMAZON MKTPLACE PMTS" -> amazon.com
  for (const [key, dom] of Object.entries(KNOWN)) {
    if (n.includes(key)) return dom
  }

  // Heuristic: single-word merchant, treat as {word}.com
  // Skip obvious abbreviations and store codes
  const cleaned = n.replace(/[^a-z0-9]/gi, "")
  if (cleaned.length >= 4 && cleaned.length <= 20 && /^[a-z]+$/.test(cleaned)) {
    return `${cleaned}.com`
  }

  return null
}

export function logoUrlFor(merchant: string | null | undefined): string | null {
  if (!merchant) return null
  const domain = resolveDomain(merchant)
  if (!domain) return null
  return `https://img.logo.dev/${domain}?token=pk_L5z-h1S2RseT3l6tpv2b1w&size=40`
}