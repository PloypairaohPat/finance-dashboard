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
import { periodProgress, usePeriod } from "./PeriodProvider"
import type { CategorySpend, PeriodInfo } from "./types"

// ─────────────────────────────────────────────────────────────────
//  OverviewView — the Overview tab (index route).
//
//  Moved out of App.tsx's dashboard JSX unchanged: same sections, same order,
//  same "only when accounts exist" gating, same markup. Two things have since
//  left it (M7.1 stage 3): the header, now AppHeader above <Routes>, and the
//  Alerts section, replaced by the header's alerts bell.
//
//  Unlike the other four tabs, the hero and Spending breakdown RECEIVE App's
//  data as props instead of fetching their own. App still needs that data for
//  itself (the connect panel's checklist, the auto-sync timer, `connected`),
//  and App's triggerRefresh re-fetches it, so props keep one copy that Sync
//  already updates. The widgets below fetch for themselves and re-fetch on
//  every sync through useSyncVersion (SyncProvider, M7.1 stage 4).
//
//  Section headers don't state how many periods a chart covers ("last 12
//  months"): since periods before a user's first transaction are dropped, the
//  count varies per user, and the charts themselves report their real length.
//
//  The connect/setup block is passed in as a rendered slot: it depends on
//  App-owned Plaid Link state, and slotting it keeps the DOM order identical.
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
  /** The money period `categories` covers (from /categories), or null before it loads. */
  categoriesPeriod: PeriodInfo | null
}

export default function OverviewView({
  setupPanel,
  heroProps,
  showHero,
  hasAccounts,
  categories,
  categoriesPeriod,
}: OverviewViewProps) {
  const isMobile = useMediaQuery("(max-width: 640px)")
  const { startDay } = usePeriod()
  const breakdownProgress = periodProgress(categoriesPeriod)

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

        {/* Spending Breakdown + Month-over-Month — both cover the current money
            period, so they can be read side by side (M7.2). */}
        {hasAccounts && (
          <div style={styles.section}>
            <section style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr",
              gap: 24, marginBottom: 32,
            }}>
              <div style={panel}>
                <h3 style={{ ...panelTitle, marginBottom: categoriesPeriod ? 4 : 16 }}>Spending breakdown</h3>
                {categoriesPeriod && (
                  <div style={{
                    fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5,
                    color: "#5a7a5a", letterSpacing: ".04em", marginBottom: 12,
                  }}>
                    {categoriesPeriod.longLabel}
                    {breakdownProgress && <span style={{ color: "#f0a030" }}> · {breakdownProgress}</span>}
                  </div>
                )}
                <SpendingChart data={categories} />
              </div>
              <div style={panel}>
                <h3 style={panelTitle}>{startDay === 1 ? "Month over month" : "Period over period"}</h3>
                <CategoryComparison />
              </div>
            </section>
          </div>
        )}

        {/* Monthly Spending Trend — the chart reports how many periods it covers. */}
        {hasAccounts && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Monthly Spending</h2>
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

        {/* Cash Flow + Savings Trend — Monthly savings reports its own period count. */}
        {hasAccounts && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Cash Flow</h2>
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
                <h3 style={panelTitle}>{startDay === 1 ? "Monthly savings" : "Savings per period"}</h3>
                <SavingsTrend />
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}
