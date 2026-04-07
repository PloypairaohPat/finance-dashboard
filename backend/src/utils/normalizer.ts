const ALIASES: Record<string, string> = {
  'wholefds':  'Whole Foods',
  'wholefood': 'Whole Foods',
  'mcdonald':  "McDonald's",
  'chick-fil': 'Chick-fil-A',
  'sq *':      '',
  'tst*':      '',
  'vzwrlss':   'Verizon',
  'openai':    'OpenAI',
}

export function normalizeMerchant(
  name:         string,
  merchantName: string | null
): string {
  // 1. Prefer Plaid's merchantName — already clean when present
  if (merchantName?.trim()) return toTitleCase(merchantName.trim())

  // 2. Check alias map
  const lower = name.toLowerCase()
  for (const [key, val] of Object.entries(ALIASES)) {
    if (lower.includes(key)) {
      const result = val || name.replace(new RegExp(key, 'i'), '').trim()
      return toTitleCase(cleanRaw(result))
    }
  }

  // 3. Apply regex rules to the raw name
  return toTitleCase(cleanRaw(name))
}

function cleanRaw(raw: string): string {
  return raw
    .replace(/#\w+/g,              '')
    .replace(/\*[\w\d]+$/g,        '')
    .replace(/\s+[A-Z]{2,3}$/,     '')
    .replace(/\.(com|net|org)$/gi, '')
    .replace(/\s{2,}/g,            ' ')
    .trim()
}

function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}