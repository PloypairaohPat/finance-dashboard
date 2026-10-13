# Threat model

What Ledger protects, from whom, how, and what's left open. Written from the code as of
October 2026 (M7.7), at one real user plus the public demo. Revisit it before inviting
testers, and whenever a new Plaid product (Liabilities, Investments) or a new store of
personal data is added. The user-facing view is [data-handling.md](data-handling.md).

## The system

```
browser ──HTTPS──> Vercel (static site)
   │
   └──HTTPS, Clerk session token in the Authorization header──> Railway (Express backend)
                                                                   │  ├─> Supabase Postgres
                         Plaid ──signed webhooks──────────────────>│  ├─> Plaid API
                                                                   │  ├─> Clerk API
                                                                   │  └─> Sentry
Railway cron (ledger-backup) ──read-only role──> Supabase ──age-encrypted──> Cloudflare R2
GitHub ──merge to main──> Railway (backend, backup job) and Vercel (site); CI on every PR
```

Trust boundaries: the browser and anything it sends; Plaid's webhooks; each vendor
account; the database role; the operator's own machine.

## What's worth protecting

1. **Plaid access tokens,** and the two secrets that make them usable: `ENCRYPTION_KEY`
   and `PLAID_SECRET`. Read-only access to someone's bank data for as long as the Item lives.
2. **Users' financial data:** transactions (including Plaid's full payloads), balances,
   recurring streams, notes and tags.
3. **Database credentials:** `DATABASE_URL`, and the backup role's password, which can
   read every row by design.
4. **Sign-in:** Clerk sessions and `CLERK_SECRET_KEY`.
5. **The audit log's key** (`AUDIT_HASH_KEY`), which turns its hashes back into people.
6. **The backup key** (age secret key), held offline by the operator.
7. **The deploy pipeline:** anyone who can merge to `main` ships to production.

## Who might attack, and how

| Threat | Controls in place | Left open |
| --- | --- | --- |
| **One user reads or changes another's data** (IDOR) | Every query is scoped to the session's user id; mutations check ownership first. Composite foreign keys stop a subscription answer or stream pointing at another user's rows. An isolation suite in CI attempts cross-user reads and writes and checks the database afterwards. | New models (Liabilities, Investments) need the same tests before they hold real data. |
| **A forged session or cross-site request** | Clerk verifies the session token on every request. It travels in a header, not a cookie, so cross-site request forgery doesn't apply. CORS limits which sites' scripts may call the API. | The CORS rule matches any Vercel project whose name starts `finance-dashboard`, not just ours, and Clerk's `authorizedParties` isn't set. Both are low impact while auth is header-only; tighten both. |
| **The public demo used as a way in** | `X-Demo-Mode` resolves only to the invented demo user, even alongside a real session; demo requests can't write; tested. | — |
| **Forged Plaid webhooks** (triggering syncs, burning quota) | ES256 signature checked against Plaid's key, a 5-minute window, a hash of the exact body; fails closed before any database work. | — |
| **Access tokens stolen from the database** | AES-256-GCM, a fresh IV each time, the key only in Railway and checked at startup; tokens never logged or returned. | The database and Railway together give working tokens. They're read-only: no money moves. |
| **Abuse and cost** (scraping, link spam, Plaid bills) | Rate limits: 150 requests per 15 minutes per IP, 20 on the endpoints that cost Plaid money; a 10-minute cooldown on refreshing recurring streams. | Plaid bills per live Item, so an idle tester's connection costs money until removed. |
| **Leaks through telemetry** | Sentry gets no bodies, cookies, auth headers, URL queries, backend log lines, or token-, key- or secret-shaped values (both apps, tested). Railway keeps logs 7 days. | Sentry events for deletion and Plaid failures carry a Clerk user id or a Plaid Item id, on purpose. Logs name users by Clerk id and the bank linked. Sentry's server-side scrubbers should be confirmed on. |
| **Secrets or personal data in the repo or the bundle** | A full-history secret scan came back clean (Phase 6). CI fails on anything shaped like a real Clerk id, Plaid id or dated amount. The browser bundle holds only the API URL, Clerk's publishable key and the Sentry DSN, all public by design. | The live site serves source maps, so the frontend's full source is public. Harmless while the repo is public; decide with the repo's visibility. |
| **A malicious or vulnerable dependency** | Lockfiles; `npm ci` in CI; the `dependency-audit` gate fails on a high or critical runtime advisory; Dependabot weekly, with deliberate holds on majors; the backup image pinned by digest. | Create React App's build tooling carries advisories that only replacing it clears. Actions are pinned by major version, not commit SHA. `dependency-audit` isn't yet a required check. |
| **A vendor account taken over** (GitHub, Railway, Supabase, Vercel, Clerk, Plaid, Sentry, Cloudflare) | Two-factor sign-in on each; `main` protected by a ruleset (PR required, no force-push or deletion, required checks); secrets live only in the vendors' settings. | Confirm two-factor on Cloudflare and the ruleset's bypass list in the next access review. GitHub reaches everything that deploys. |
| **Someone with database access** (a leaked `DATABASE_URL`, a hosting breach) | The audit log's triggers refuse edits, truncation and early deletion, and stamp each row's time. | The app and migrations share one role, which owns the audit table and could drop its triggers. The backup role's password reads every row. Separate roles would close the first; accepted at this scale. |
| **Data loss** (a bad migration or script, a hosting failure) | Nightly encrypted backups to R2, kept 30 days with a 7-day lock no token can override; a Sentry monitor on every run; a monthly restore drill that compares every table. | A restore rolls the audit log back too; the documented post-restore check re-deletes anyone deleted since. A Postgres 18 upgrade breaks the dump until the image moves with it. |
| **A deletion that stops halfway** | The account is blocked before anything irreversible; row deletion retries; once a bank is disconnected, a failure keeps the account blocked and raises a Sentry alert; `delete-user.ts` finishes it. | Finishing depends on that alert reaching the operator. |
| **Keeping more than needed** | Unlink and account deletion remove every dependent row; backups expire; the audit log holds only codes and keyed hashes. | Plaid's full payload is stored per transaction. Hidden transactions stay until unlink or deletion. A bank-side revocation is recorded, not acted on. |
| **The operator's own machine** | Production credentials don't live in local env files: local scripts refuse to run against production without a flag naming the host, and read-only scripts prove they can't write. Secrets go from where they're shown to where they're used. | Relies on habit: a secret that appears in a screenshot, a chat or a command line is treated as leaked and rotated. |

## Accepted at today's scale

- One database role for the app and migrations.
- No penetration test, bug bounty or formal audit.
- Header-token auth with a broad CORS pattern.
- Supabase Free: no point-in-time recovery; Ledger's own backups instead.

Each is written down so it's a decision, not an oversight. The tester checkpoint is the
moment to look at them again.

## Open items, in order

1. Confirm two-factor on Cloudflare; make `dependency-audit` a required check; confirm
   the ruleset's bypass list is empty.
2. Confirm Sentry's server-side Data Scrubber is on in both projects.
3. Tighten CORS to Ledger's own origins and set Clerk's `authorizedParties` (prove it with
   a local sign-in).
4. Decide the repo's visibility, and source maps with it.
5. Isolation tests for every new model before it holds real data (M7.4).
6. Act on bank-side revocations: delete what was revoked.
7. Separate database roles for the app and for migrations.
