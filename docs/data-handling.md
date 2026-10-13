# How Ledger handles your data

What Ledger keeps when you connect a bank, where it lives, who can see it, how long it
stays, and what disconnecting or deleting your account removes. Written from the code as
of October 2026 (M7.7). The engineering view of the same ground is
[threat-model.md](threat-model.md); backups are in [backups.md](backups.md).

## In short

- **Read-only.** Ledger reads balances and transactions through Plaid. It can't move
  money, and it never sees your bank login: you type that into Plaid's window, not Ledger's.
- **Your bank connection's key is encrypted.** Plaid gives Ledger an access token per
  bank connection; it's stored encrypted (AES-256-GCM), and the key lives only in the
  backend's hosting settings.
- **Only you see your data in the app.** Every query is limited to your own user id, and a
  test suite in CI tries to read and change other users' data on every change.
- **You can remove it.** Disconnecting a bank deletes that bank's data. Deleting your
  account disconnects every bank and deletes everything. Encrypted backups age out within
  30 days.
- **Ledger is run by one person,** who can read the database. There's no separate admin
  tool; access is through the hosting providers' own accounts.

## What Ledger stores

| What | Comes from | Why |
| --- | --- | --- |
| **Your user record:** your sign-in provider's user id and three settings (the day your month starts; two on/off choices) | Clerk, and you | To tie everything else to you. Ledger doesn't store your name or email; Clerk keeps those. |
| **Bank connections:** Plaid's access token (encrypted), the bank's name and id, a sync position, the connection's health | Plaid | To fetch new transactions and show whether a connection needs fixing. |
| **Accounts:** name, official name, type, the last 4 digits Plaid shows, current and available balance | Plaid | Balances, net worth, the Accounts tab. Never full account or card numbers. |
| **Transactions:** date, amount, description, merchant, Plaid's categories, whether it's pending, and **Plaid's full record of the transaction as first received** | Plaid | Everything the app shows. The full record is kept so categorisation can be re-run without asking Plaid again. |
| **Your additions to transactions:** tags, notes, your corrections (income or repayment) | You | Shown back to you; used in totals. |
| **Recurring streams:** Plaid's grouping of repeating charges and deposits: description, merchant, typical and last amount, dates, how often | Plaid | The Subscriptions & Bills tab and the missed-paycheck alert. |
| **Subscription answers:** which streams you confirmed or dismissed | You | So your answer sticks. |
| **Daily balance snapshots:** each account's name, type and balances, once a day | Ledger, from Plaid's balances | The net-worth history chart. |
| **Budgets, goals, alerts** | You, and Ledger's own checks | The Budgets tab, goals and the alert bell. |

**What Ledger never has:** your bank username or password; full account or card numbers;
any way to move money. Plaid products in use: Transactions and its recurring-transactions
feature. Liabilities and Investments aren't enabled.

**In your browser,** Ledger keeps one thing: whether you're in the demo, in session storage
for that tab. Your sign-in is Clerk's.

## Where it lives

| Service | What it holds | Notes |
| --- | --- | --- |
| **Supabase** (PostgreSQL, AWS US East) | The database: everything in the table above | Encrypted at rest by the host. |
| **Railway** | The backend; the encryption key and other secrets as settings; 7 days of logs | Logs name users by sign-in id, and the bank you link. |
| **Plaid** | Your bank connection | Under Plaid's own privacy policy. |
| **Clerk** | Your sign-in: email, sessions | Under Clerk's own policy. |
| **Vercel** | The website's files | No financial data. |
| **Sentry** | Error reports from the backend and the website | Scrubbed before sending (below). |
| **Cloudflare R2** | Nightly database backups, **encrypted before upload** | Unreadable without a key only the operator holds, offline. |
| **Google Fonts** | Nothing of yours | Your browser fetches fonts from Google, which sees your IP address and browser like any site you load. |
| **GitHub** | The code | No user data. CI checks every change for anything shaped like a real id or a dated amount. |

## How it's protected

- **In transit:** HTTPS everywhere.
- **Plaid access tokens:** AES-256-GCM with a fresh IV each time; the key lives only in
  Railway's settings and is checked at startup. Tokens are never logged or sent to the
  browser.
- **Between users:** every database query is limited to the signed-in user's id; the
  database itself refuses a subscription answer or recurring stream that points at another
  user's data; an isolation suite in CI tries cross-user reads and writes on every change
  and checks the database afterwards.
- **The public demo** is a separate, invented user. Demo requests can only reach that user
  and can't change anything.
- **Plaid's webhooks** are signature-checked before Ledger acts on them.
- **Error reports (Sentry)** never include request bodies, cookies, sign-in headers, URL
  queries (what you searched or filtered on), the backend's log lines, or anything shaped
  like a token, key or secret. They can include the page or API path, the error, and for some
  account-deletion and Plaid failures your sign-in id or a bank connection's Plaid id, so a
  failure can be finished by hand.
- **Backups** are encrypted with `age` on the way out of the database's network; the job
  that writes them can't read them.

## How long it stays

| What | How long |
| --- | --- |
| Your data in the app | Until you disconnect the bank it came from, or delete your account. |
| Transactions Plaid later removes (a pending charge that posts, say) | Hidden at once; deleted when you disconnect that bank or delete your account. |
| Encrypted backups | Up to 30 days, then deleted automatically. They can't be edited, so something you delete stays in backups until they expire. |
| Backend logs (Railway) | 7 days. |
| Error reports (Sentry) | Sentry's retention for the plan in use. |
| The security audit log | 400 days (below). |
| What Plaid and Clerk keep | Their own policies. |

## Disconnecting a bank

Ledger asks Plaid to revoke the connection, then deletes that bank's accounts,
transactions (with their tags, notes and your subscription answers), recurring streams and
balance snapshots. Your budgets, goals, alerts and settings stay.

Connecting the same bank again starts fresh: tags, notes and subscription answers from
before don't come back.

## Deleting your account

Settings → **Delete account and all data**. Ledger signs you out and blocks the account,
asks Plaid to revoke every bank connection, deletes every row of yours in every table, then
deletes your Clerk account. If something fails after a bank has already been disconnected,
the account stays blocked, the operator is alerted, and the deletion is finished by hand.

What remains afterwards: encrypted backups until they expire (up to 30 days), backend logs
(7 days), error reports under Sentry's retention, the audit log's record that a deletion
happened (below), and whatever Plaid and Clerk keep under their own policies.

If a backup ever has to be restored, anyone deleted after that backup was taken is deleted
again as part of the restore ([backups.md](backups.md)).

## The audit log

Ledger keeps an append-only log of security events: a bank linked, discarded or
disconnected; Plaid reporting that access was revoked; each step of an account deletion; a
sign-in session seen for the first time. It keeps no amounts, names or free text.

People, bank connections and sessions appear only as keyed hashes. That makes the log
**pseudonymous, not anonymous**: while the operator holds the key, anyone with the key and
your sign-in id can find your rows. The log is kept for 400 days and **outlives account
deletion on purpose**: "an account was deleted" is one of the things it exists to record.
The database refuses edits to it and deletions younger than 400 days.

## Not built yet

- **Revoked access at the bank.** If you revoke Ledger's access from your bank's website,
  Plaid tells Ledger. Today that's recorded in the audit log and the connection is marked
  revoked, but the data already fetched isn't deleted automatically. Disconnect the bank in
  Ledger, or delete your account, to remove it.
- **Purging hidden transactions** while the bank stays connected.
- **Exporting your data.**
- **Keeping tags and notes across a re-link.**
