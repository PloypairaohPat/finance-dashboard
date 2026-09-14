import TabPage from "./TabPage"
import SubscriptionTracker from "./SubscriptionTracker"

// SubscriptionTracker already fetched its own data and took no props from App,
// so this tab is a straight move with no state to lift or re-fetch.
export default function SubscriptionsView() {
  return (
    <TabPage title="Subscriptions & Bills">
      <SubscriptionTracker />
    </TabPage>
  )
}
