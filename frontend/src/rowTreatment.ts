// ─────────────────────────────────────────────────────────────────
//  rowTreatment.ts — how a transaction row looks, from what it means (M7.3)
//
//  Rows used to be styled by the sign of the amount. A card payment's card-side
//  leg therefore read "+$812.34", like income, while every total said it was
//  neither. Rows are now styled from the classifier's verdict:
//
//    - money you spent or earned keeps its familiar treatment
//    - money coming BACK (a refund, a friend repaying you) is marked as such and
//      keeps its "+", because it genuinely increases what you have
//    - money that is neither — a card payment, a transfer between your own
//      accounts — is neutral: muted, no sign, a direction arrow, and a label
//
//  Because colour now carries less meaning, the chip carries it. The chip is
//  therefore always rendered, never hover-only, and must not be truncated.
// ─────────────────────────────────────────────────────────────────

import { colors } from "./tokens"
import type { RowMeaning } from "./types"

export interface ChipStyle {
  label: string
  color: string
  background: string
  border: string
}

export interface RowTreatment {
  /** Text for the amount column, including any sign or arrow. */
  amountText: string
  amountColor: string
  /** The meaning chip, or null when the row is ordinary spending or income and its category chip suffices. */
  chip: ChipStyle | null
}

// Neutral has to be neutral against THIS theme. Every muted token here is
// green-tinted (muted2 is #8ab88a), and on the dark background a green-tinted
// amount reads as money earned — the exact misreading this treatment exists to
// remove. So neutral rows use true greys, not theme tokens, and a grey border
// that also keeps the chip distinct from the green-bordered category chips.
const NEUTRAL = {
  amount: "#a8aaa9",
  chipText: "#c2c4c3",
  chipBackground: "rgba(255,255,255,0.04)",
  chipBorder: "#4a4c4b",
}

const NEUTRAL_KINDS = new Set<RowMeaning["kind"]>([
  "card_payment",
  "internal_transfer",
  "savings_transfer",
  "credit_inflow_not_income",
  "unclassified_inflow",
])

export function isNeutral(meaning: RowMeaning): boolean {
  return NEUTRAL_KINDS.has(meaning.kind)
}

export function treatmentFor(
  amount: number,
  meaning: RowMeaning,
  fmt: (n: number) => string,
): RowTreatment {
  const magnitude = fmt(Math.abs(amount))
  const incoming = amount < 0

  if (isNeutral(meaning)) {
    // No sign: a sign is exactly what made these read as spending or income.
    // The arrow keeps direction without implying either.
    return {
      amountText: `${magnitude} ${incoming ? "←" : "→"}`,
      amountColor: NEUTRAL.amount,
      chip: {
        label: meaning.label,
        color: NEUTRAL.chipText,
        background: NEUTRAL.chipBackground,
        border: NEUTRAL.chipBorder,
      },
    }
  }

  switch (meaning.kind) {
    case "refund":
      return {
        amountText: `+${magnitude}`,
        amountColor: colors.green,
        chip: { label: meaning.label, color: colors.green, background: colors.greenBg, border: "rgba(0,232,122,.3)" },
      }
    case "payment_app_in":
      return {
        amountText: `+${magnitude}`,
        amountColor: colors.blue,
        chip: { label: meaning.label, color: colors.blue, background: "rgba(74,158,255,0.08)", border: "rgba(74,158,255,.3)" },
      }
    case "income":
      return { amountText: `+${magnitude}`, amountColor: colors.green, chip: null }
    case "spend":
    default:
      return {
        amountText: magnitude,
        amountColor: colors.textHi,
        // A payment to a person is spending, but "Transfer Out" from Plaid's
        // category would misdescribe it — say what it is instead.
        chip: meaning.label !== "Spending"
          ? { label: meaning.label, color: colors.text, background: colors.surface3, border: colors.border2 }
          : null,
      }
  }
}
