import { useState } from "react"
import TabPage from "./TabPage"
import TransactionList from "./TransactionList"
import TransactionDetail from "./TransactionDetail"
import type { EnrichedTransaction } from "./types"

// ─────────────────────────────────────────────────────────────────
//  TransactionsView — the Transactions tab.
//
//  `selectedTx` used to live in App.tsx, which meant App held state only one
//  route could ever use. It is lifted to here rather than pushed into
//  TransactionList because the open/closed state of a detail modal belongs to
//  the page that owns both the list and the modal, not to the list itself.
//
//  Search and filter state deliberately does NOT live here — it lives in the
//  URL, read and written by TransactionList via useUrlParams, so a filtered
//  view is linkable and survives Back/Forward.
// ─────────────────────────────────────────────────────────────────

export default function TransactionsView() {
  const [selectedTx, setSelectedTx] = useState<EnrichedTransaction | null>(null)

  return (
    <TabPage title="Transactions">
      <TransactionList onRowClick={setSelectedTx} />

      {/* Fixed-position overlay, so nesting it inside the page is fine. */}
      {selectedTx && (
        <TransactionDetail
          transaction={selectedTx}
          onClose={() => setSelectedTx(null)}
          onUpdate={(updated) => setSelectedTx(updated)}
        />
      )}
    </TabPage>
  )
}
