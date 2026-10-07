# Demo browser checklist

Walk this in a real browser after any change to the demo, the Subscriptions & Bills tab or the
bell, and before merging a PR that changes what the demo shows. Open the app with `?demo=1`,
at desktop width and again at about 375 px wide.

Items marked **(5e)** hold since the tab reads Plaid's streams (M7.6 PR 5e).

## Pending charges

- [ ] Three pending rows carry the **Pending** chip in the transaction list.
- [ ] **Gadgethaus** shows the Pending chip in Largest purchases, and the bell has no
      large-purchase alert for it.
- [ ] Top merchants says **"includes pending"**.
- [ ] A pending row's panel says **"Available once this posts"**, and nothing flashes
      "Changes not saved" when the panel opens.

## The marked gym

- [ ] The Ironline gym (shown under the name of its first charge, "IRONLINE FITNESS") is in
      Subscriptions with **Confirmed by you**, and a **+40%** price chip.
- [ ] The bell has a price-up alert for it.

## Subscriptions and Bills (5e)

- [ ] **Subscriptions:** Netflix, Spotify, CrossFit Downtown, Viewloom (with a **+20%** chip),
      the Ironline gym, and Lingohall with **Ended** and **Confirmed by you**.
- [ ] **Bills:** Greystone Apartments, City Power & Light, Xfinity, T-Mobile, Geico, the car
      loan, and the monthly transfer to R Okafor with **Confirmed by you**.
- [ ] Opening one of R Okafor's charges, the panel says **"Marked as a bill · Unmark"** and
      that it's tracked under Bills. A Netflix charge says it was found automatically, under
      Subscriptions.
- [ ] Hovering **Ended** on Lingohall says Plaid reports it has stopped.
- [ ] **FIDELITY TRANSFER** is in Subscriptions with **Confirmed by you** and **Not counted**;
      hovering **Not counted** says its charge isn't counted as spending any more. It adds
      nothing to the Subscriptions total, has no Upcoming date, and its row has **Unmark**
      (which shows the demo message).
- [ ] Each card's monthly total is the sum of its rows that are active and on a known schedule:
      Lingohall adds nothing.
- [ ] **Not recurring** shows on every row that is a stream, and not on the Ironline gym, which
      is a marked series.
- [ ] Upcoming lists only active, counted rows, soonest first.
- [ ] There is no "Updated … ago" line in the demo (its streams are never refreshed), and
      **Sync** shows the demo message.

## Suggested (5e)

- [ ] A **Suggested** card lists Apple iCloud and Brightbox, says **"not in totals"**, and adding
      them up changes no card's total.
- [ ] Brightbox carries the **New** chip; iCloud doesn't.
- [ ] Each row says where confirming puts it ("Confirming adds it to Subscriptions").
- [ ] **Dismissed (1)** starts collapsed. Opened, it lists Shearwater Salon with **Restore**, and
      no "Confirmed by you".

## Demo mode refuses every answer (5e)

- [ ] **Confirm**, **Dismiss**, **Not recurring** and **Restore** each show the demo message
      ("Demo mode — changes aren't saved…").
- [ ] Nothing moves between lists, no **Undo** appears, and nothing says it saved.

## The bell (5e)

- [ ] Price-up alerts for Viewloom and the Ironline gym, and no subscription alert for anything
      missing from the tab.

## The missed-paycheck alert (M7.6 PR 6b)

- [ ] The bell has **"Your paycheck from LANTERN BOOKS PAYROLL hasn't arrived"**, medium, saying
      when it was due (7 days before the reseed) and that it hasn't reached Everyday Checking.
- [ ] There's no such alert for the main salary (BRIGHTLINE PAYROLL, the 1st and the 15th).
- [ ] A **Settings** button sits beside "Exit demo". The dialog shows **Tell me when a paycheck
      is late** ticked, with no "we haven't found a regular paycheck" line under it.
- [ ] Unticking it (or changing any setting) shows the demo message at once, and the box stays
      ticked. There is no "Delete account and all data" section in the demo.
- [ ] A week after a reseed the alert is gone (the side job's next payday came): reseed to see
      it again.

## Phone width (about 375 px)

- [ ] Every chip (Pending, New, Ended, Confirmed by you, the price chips) is fully visible: not
      clipped, not cut short with "…", not shown only on hover. Names shorten first.
- [ ] The Confirm, Dismiss, Not recurring and Restore buttons wrap under the name rather than
      pushing the amount off screen; the page never scrolls sideways.
