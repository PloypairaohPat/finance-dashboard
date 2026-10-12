# Backups

Ledger's production database (Supabase Free, which keeps no backups of its own) is backed up
once a day, encrypted before it leaves the database's network path, to a Cloudflare R2 bucket
that keeps each backup for up to 30 days. This page covers setting it up, what to do when it
alerts, the restore drill, a real restore, and manual dumps.

**For the data-handling doc:** deleted data stays in encrypted backups for up to 30 days.

## What runs

A Railway service built from `backup/` (config `backup/railway.json`) runs `backup/run.sh` at
**03:17 UTC** every day, clear of the backend's own jobs (syncs at 00, 06, 12 and 18; the 07:00
streams backstop; midnight's keepalive and audit-log expiry). It:

1. checks in with Sentry (`in_progress`);
2. checks its variables, failing closed and naming only what's missing or malformed;
3. runs `pg_dump` 17 (custom format, `public` schema, `--no-owner --no-privileges`) as the
   read-only `backup_reader` role over the session pooler (port 5432), pipes it through
   `age` to the backup public key, and streams that to R2 under `incoming/`;
4. only if every stage succeeded and the object is at least 8 KiB, moves it to `daily/` as
   `ledger-<UTC date>T<HHMMSS>Z.dump.age`;
5. checks in `ok`, or `error` on any failure (and deletes what it put in `incoming/`).

The whole run has a 15-minute timeout: Railway never kills a hung run, and skips the next ones
while it's running. The plaintext dump only ever exists in the pipe. The private key never
reaches Railway, the repo or CI, so the job can write backups but not read them.

R2 keeps `daily/` objects 29 days (lifecycle rules run about daily, so "up to 30 days" holds),
clears `incoming/` after a day, and a bucket lock stops anything in `daily/` being deleted for
its first 7 days, even with the job's token.

## Setting it up

In this order. The Railway service is created after the merge: before it, `main` has no
`backup/railway.json`, and Railway would fall back to its defaults (no cron).

1. **age 1.3.2 on your machine:** `winget install --id FiloSottile.age -e --version 1.3.2`
   (the official zip, checked against winget's SHA-256), then a new terminal and `age --version`.
2. **The keypair:** `age-keygen`, with no `-o` and no `-pq`. It prints both keys and writes
   nothing. Store the `AGE-SECRET-KEY-1…` line in the password manager and make an offline copy;
   keep the `age1…` public key for Railway. Close that terminal window afterwards. (The image's
   age is 1.2.1, which encrypts to X25519 keys only; that's why no `-pq`.)
3. **R2:** a bucket; lifecycle rules `daily/` → delete after 29 days and `incoming/` → delete
   after 1 day; a bucket lock on `daily/` for 7 days; an API token with **Object Read & Write**,
   scoped to that bucket only.
4. **The role**, in Supabase's SQL editor:
   ```sql
   CREATE ROLE backup_reader LOGIN BYPASSRLS;
   GRANT pg_read_all_data TO backup_reader;
   ALTER ROLE backup_reader SET default_transaction_read_only = on;
   ```
   `pg_read_all_data` covers tables added later. Set its password with `psql`'s `\password`
   (it prompts, never echoes, and sends only a hash; the SQL editor keeps snippet history), from
   `backend/`:
   ```
   railway run -- docker run --rm -it -e DIRECT_URL postgres:17-alpine sh -c 'set -f; psql $DIRECT_URL'
   ```
   then `\password backup_reader`. Its URL is the session pooler's (port 5432) with the user
   `backup_reader.<project ref>`.
5. **Merge** the PR that adds `backup/`.
6. **The same evening, before 03:17 UTC:**
   - Railway: a new service from this repo; config file `/backup/railway.json`; variables
     `BACKUP_DATABASE_URL`, `BACKUP_AGE_RECIPIENT`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
     `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `SENTRY_DSN` (the backend's DSN is fine).
   - Sentry: a cron monitor, slug **`ledger-db-backup`**, crontab `17 3 * * *` UTC, check-in
     margin 30 minutes, max runtime 20 minutes, an issue on the first failed or missed check-in;
     and an alert rule on it. Created the same day as the service, so it doesn't alert on runs
     that couldn't have happened.
7. **The next morning:** an `ok` check-in in Sentry and an object in `daily/`; then the drill
   (below).

## When Sentry alerts

- **Missed:** the job didn't start, or couldn't reach Sentry (no `SENTRY_DSN`). Check the
  service's latest cron run in Railway, and its variables.
- **Error:** the Railway log for that run says which step failed, by variable name or by stage.
  A wrong password or an unreachable pooler shows as "did not finish". Nothing it uploaded is in
  `daily/`.
- **Timeout** (max runtime): a hung run. Check Railway; a later run can't start until it ends.

Until it's fixed, take a manual dump (below) if a day without a backup matters.

## The restore drill

Monthly, and after any migration that adds a table. From `backend/`:

1. Download the newest object under `daily/` from the Cloudflare dashboard (no R2 credential on
   your machine).
2. Run the drill, comparing with production read-only:
   ```
   railway run npx tsx scripts/restore-drill.ts --file C:\Users\kpaoi\Downloads\<name>.dump.age --allow-remote aws-1-us-east-2.pooler.supabase.com
   ```
   It asks for the secret key at a hidden prompt, restores into a fresh in-memory Postgres 17
   container, checks the audit log's triggers and limits, the required tables (`User`,
   `AuditEvent`, `RecurringStream`, `SubscriptionMark`, `_prisma_migrations`) and stray tables,
   and compares per-table counts with production rows created at or before the backup's time.
   Fewer rows than that fails; more (after unlinks or account deletions since) is noted.
3. **The downloaded file:** after a pass, the drill deletes it, so no copy of a backup outlives
   the 30-day retention (`--keep` keeps it). After a failure it keeps it and says so: delete it
   once you're done. It never deletes a file that isn't named like the job's backups (for
   example a manual dump): delete those yourself when they're no longer needed.

A file not named like the job's (`ledger-<date>T<time>Z.dump.age`) needs `--taken-at <ISO time>`.

## Restoring for real

Always into an **empty** database, schema and data together. **Never a data-only restore into a
database that already has the AuditEvent triggers**: they would rewrite every row's `at` and
refuse the rows. A full restore loads rows before it creates triggers, which is why it's safe.

1. Create the target (a new Supabase project, say) and get an admin URL for it.
2. In PowerShell, from anywhere (the URL is typed, not stored in history):
   ```
   $env:RESTORE_TARGET_URL = Read-Host 'target database URL'
   docker run --rm -i -e RESTORE_TARGET_URL --tmpfs /work -v C:\Users\kpaoi\Downloads:/in:ro -v "C:\Users\kpaoi\Personal Finance Dashboard\backup:/b:ro" postgres:17-alpine sh /b/restore.sh /in/<name>.dump.age
   ```
   Paste the secret key, then Enter and Ctrl+D. `backup/restore.sh` refuses a target whose
   `public` schema has tables, decrypts into memory only, and skips just the dump's
   `CREATE SCHEMA public` and its comment (the target has `public` already).
3. Point the backend at the target, then `npx prisma migrate status`: anything after the
   backup applies with the next deploy, as usual.
4. **Run the deletions again.** Anyone deleted after the backup was taken is back. From
   `backend/`, against the restored database:
   ```
   railway run npx tsx scripts/post-restore-check.ts --allow-remote <restored db host> --taken-at <backup time, ISO>
   ```
   It reads the restored users and checks two sources:
   - **The old database's audit log**, if it's still reachable (`--old-url-env NAME`, the
     variable holding its URL): `deletion.completed` events after the backup's time, matched by
     keyed hash under `AUDIT_HASH_KEY`. That key must be the one production used.
   - **Clerk:** a restored user Clerk no longer has was deleted. **This only works while we stay
     on the same Clerk instance.** After a move to production Clerk keys every user id changes,
     and every restored user would look deleted: pass `--no-clerk` and rely on the audit log.

   It prints, for each one, the `delete-user.ts` dry run to start with. Then delete the downloaded
   file.

## A manual dump

Before something risky, or when the job is down. It uses the job's read-only role and writes
only ciphertext (plaintext stays in the container's pipe), named `ledger-manual-…` so the drill
never deletes it. From `backend/`, linked to the backup service in Railway:

```
railway run --service <backup service> -- docker run --rm -e BACKUP_DATABASE_URL -e BACKUP_AGE_RECIPIENT -v C:\Users\kpaoi\ledger-backups:/out postgres:17-alpine sh -c 'set -f -o pipefail; apk add -q age; pg_dump --format=custom --schema=public --no-owner --no-privileges --dbname=$BACKUP_DATABASE_URL | age -r $BACKUP_AGE_RECIPIENT -o /out/ledger-manual-YYYY-MM-DD.dump.age'
```

Delete it when it's no longer needed, and no later than 30 days on.

## Keeping it working

- **A Postgres major upgrade:** `pg_dump` 17 can't dump a Postgres 18 server. When Supabase
  upgrades, the job fails loudly (a Sentry error) until `backup/Dockerfile`'s
  `postgresql17-client` becomes `postgresql18-client`; bump the drill's and `restore.sh`'s
  `postgres:17-alpine` to 18 with it.
- **A new key:** set the new public key in Railway, and keep the old secret key until the last
  backup encrypted to it has expired (29 days).
- **Changing the job:** `node backup/test/harness.mjs` (from the repo root; needs Docker, the
  local dev database and age on PATH) runs the real image against throwaway containers: a good
  run, every way it should refuse or fail, the drill and `restore.sh`. CI runs shellcheck and
  checks the image builds with the right tools. Run shellcheck locally with the same pinned
  version CI uses, `koalaman/shellcheck:v0.11.0`, from the repo root:
  `docker run --rm -v ${PWD}\backup:/mnt:ro koalaman/shellcheck:v0.11.0 -s sh /mnt/run.sh /mnt/restore.sh`

## Phase 8: moving to the home server

In Phase 8 the live database moves from Supabase to a home server, and the backup job moves
with it: the same script, run nightly by a timer or a container on that server instead of
Railway's cron.

**Three copies:**

1. the live database;
2. a nightly encrypted dump on a separate disk at home, for fast restores;
3. the same dump in R2, the off-site copy. R2 and the 7-day bucket lock on `daily/` stay.

**Unchanged:**

- The age secret key never touches the server. The server holds only the public key, so it can
  write backups but not read them, local copies included.
- `pg_dump` matches the server's Postgres major, as now (see "A Postgres major upgrade" above).
- Local copies are pruned at 29 days too, so "deleted data stays in encrypted backups for up to
  30 days" stays true.
- The Sentry monitor, and the monthly drill.

**Moving day is the drill:**

1. Dump Supabase.
2. Restore it into the home Postgres (empty, schema and data, as in "Restoring for real").
3. Compare per-table counts.
4. Run the user-deletion check (`post-restore-check.ts`).
5. Once all of that is verified, delete the Supabase project.
