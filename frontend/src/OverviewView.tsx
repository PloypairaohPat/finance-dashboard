import { CSSProperties, ReactNode } from "react"
import HeroOverview, { HeroOverviewProps } from "./HeroOverview"
import WeeklyDigestCard from "./WeeklyDigestCard"
import InsightsDashboard from "./InsightsDashboard"
import SpendingChart from "./SpendingChart"
import CategoryComparison from "./CategoryComparison"
import TrendChart from "./TrendChart"
import FinancialScoreCard from "./FinancialScoreCard"
import GoalsCard from "./GoalsCard"
import NetWorthChart from "./NetWorthChart"
import CashFlowChart from "./CashFlowChart"
import SavingsTrend from "./SavingsTrend"
import useMediaQuery from "./useMediaQuery"
import type { CategorySpend } from "./types"

// ─────────────────────────────────────────────────────────────────
//  OverviewView — the Overview tab (index route).
//
//  Moved out of App.tsx's dashboard JSX unchanged: same sections, same order,
//  same "only when accounts exist" gating, same markup. Two things have since
//  left it (M7.1 stage 3): the header, now AppHeader above <Routes>, and the
//  Alerts section, replaced by the header's alerts bell.
//
//  Unlike the other four tabs, this view RECEIVES App's data as props instead
//  of fetching its own. That is deliberate. The Sync button, "Live Balances"
//  and the Plaid Link success handler show only on this route and refresh
//  App's state; if this view fetched its own copy, linking a first bank or
//  pressing Sync would leave it stale right now — the stage 4 gap, but
//  reachable today.
//
//  The connect/setup block is passed in as a rendered slot: it depends on
//  App-owned Plaid Link state, and slotting it keeps the DOM order identical.
//
//  TODO(M7.1-stage4-sync-refresh): when a shared refresh path exists, revisit
//  these props — heroProps, categories, hasAccounts and showHero are
//  App-coupled only because refresh lives in App. Remove this TODO along with
//  the others carrying it.
// ─────────────────────────────────────────────────────────────────

const styles: Record<string, CSSProperties> = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#f0ede8",
    fontFamily: "'Syne', sans-serif",
    padding: "0",
    margin: "0",
  },
  main: { maxWidth: "900px", margin: "0 auto", padding: "60px 40px" },
  section: { marginTop: "60px" },
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
    marginBottom: "24px",
    borderBottom: "1px solid #1a1a1a",
    paddingBottom: "16px",
  },
  sectionTitle: { fontSize: "22px", fontWeight: 700, letterSpacing: "-0.5px" },
  sectionCount: { fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", color: "#555" },
}

const panel: CSSProperties = { background: "#161e14", border: "1px solid #253325", borderRadius: 10, padding: 20 }
const panelTitle: CSSProperties = { fontFamily: "Fraunces, Georgia, serif", fontWeight: 300, fontSize: 18, color: "#e8f4e8", marginBottom: 16 }

export interface OverviewViewProps {
  /** Connect-your-bank block and setup checklist. Plaid Link state lives in App. */
  setupPanel: ReactNode
  heroProps: HeroOverviewProps
  /** App's `connected` flag — the hero shows once a bank is linked. */
  showHero: boolean
  /** Gates every data section, exactly as the old dashboard did. */
  hasAccounts: boolean
  categories: CategorySpend[]
}

export default function OverviewView({
  setupPanel,
  heroProps,
  showHero,
  hasAccounts,
  categories,
}: OverviewViewProps) {
  const isMobile = useMediaQuery("(max-width: 640px)")

  return (
    <div style={styles.root}>
      <main style={{ ...styles.main, padding: isMobile ? "30px 16px" : "60px 40px" }}>
        {showHero && <HeroOverview {...heroProps} />}

        {setupPanel}

        {/* Weekly Digest (M5.8). The Alerts list that sat under it is now the
            header's alerts bell (M7.1 stage 3). */}
        {hasAccounts && (
          <div style={styles.section}>
            <WeeklyDigestCard />
          </div>
        )}

        {/* Financial Insights */}
        {hasAccounts && (
          <section style={{ marginBottom: 32 }}>
            <InsightsDashboard />
          </section>
        )}

        {/* Spending Breakdown + Month-over-Month */}
        {hasAccounts && (
          <div style={styles.section}>
            <section style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr",
              gap: 24, marginBottom: 32,
            }}>
              <div style={panel}>
                <h3 style={panelTitle}>Spending breakdown</h3>
                <SpendingChart data={categories} />
              </div>
              <div style={panel}>
                <h3 style={panelTitle}>Month over month</h3>
                <CategoryComparison />
              </div>
            </section>
          </div>
        )}

        {/* Monthly Spending Trend */}
        {hasAccounts && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Monthly Spending</h2>
              <span style={styles.sectionCount}>last 12 months</span>
            </div>
            <TrendChart />
          </div>
        )}

        {/* Financial Score + Goals (M5.9) */}
        {hasAccounts && (
          <section style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1.2fr",
            gap: 24, marginBottom: 32,
          }}>
            <FinancialScoreCard />
            <div style={panel}>
              <h3 style={panelTitle}>Goals</h3>
              <GoalsCard />
            </div>
          </section>
        )}

        {/* Net Worth */}
        {hasAccounts && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Net Worth</h2>
            </div>
            <NetWorthChart />
          </div>
        )}

        {/* Cash Flow + Savings Trend */}
        {hasAccounts && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Cash Flow</h2>
              <span style={styles.sectionCount}>last 6 months</span>
            </div>
            <section style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr",
              gap: 24, marginBottom: 32,
            }}>
              <div style={panel}>
                <h3 style={panelTitle}>Cash flow</h3>
                <CashFlowChart />
              </div>
              <div style={panel}>
                <h3 style={panelTitle}>Monthly savings</h3>
                <SavingsTrend />
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}
