#!/bin/sh
# ─────────────────────────────────────────────────────────────────
#  ledger-backup — the daily encrypted production backup (M7.7).
#
#  Run by Railway's cron (backup/railway.json), once a day; exits when done.
#
#    pg_dump (custom format, public schema, no owner, no privileges)
#      | age, to BACKUP_AGE_RECIPIENT's public key
#      | rclone rcat, to R2 under incoming/
#    then, only if every stage succeeded and the object isn't implausibly
#    small, a server-side move to daily/.
#
#  No plaintext touches disk: the dump only ever exists in the pipe. The
#  private key is never here, so this job can write backups but not read them.
#  A dump that dies part-way still produces a well-formed age file, so nothing
#  in incoming/ counts until it's promoted; a failure deletes it (and R2's
#  lifecycle rule clears incoming/ after a day regardless).
#
#  Sentry cron monitor ledger-db-backup: in_progress at start, then ok or
#  error. Neither the logs nor Sentry ever see the database URL, a key, or
#  any of the dump: messages name a variable, never its value. Never add
#  `set -x`.
#
#  Required (fails closed, naming only what's missing or malformed):
#    BACKUP_DATABASE_URL   the backup_reader role's session-pooler URL (port 5432)
#    BACKUP_AGE_RECIPIENT  age1… public key
#    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#    SENTRY_DSN
#  Optional, for local testing only: R2_ENDPOINT (an S3-compatible endpoint
#  instead of R2's).
#
#  See docs/backups.md.
# ─────────────────────────────────────────────────────────────────

set -eu
# The image's /bin/sh is BusyBox ash, which has pipefail; the job depends on it.
# shellcheck disable=SC3040
set -o pipefail

MONITOR_SLUG=ledger-db-backup
TIMEOUT_SECONDS=900   # Railway never kills a hung run, and skips later ones while it runs.
MIN_BYTES=8192        # An encrypted dump of Ledger's schema alone is larger than this.

say() { printf '%s ledger-backup: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# ── Sentry ────────────────────────────────────────────────────────
checkin_url=""
check_in_id="$(cat /proc/sys/kernel/random/uuid)"

# DSN: <scheme>://<public key>@<host>/<project id>
dsn="${SENTRY_DSN:-}"
case "$dsn" in
  http://*@*/* | https://*@*/*)
    scheme="${dsn%%://*}"
    rest="${dsn#*://}"
    key="${rest%%@*}"
    hostpath="${rest#*@}"
    host="${hostpath%%/*}"
    project="${hostpath##*/}"
    if printf '%s' "$key" | grep -Eq '^[0-9a-f]{32}$' && printf '%s' "$project" | grep -Eq '^[0-9]+$'; then
      checkin_url="$scheme://$host/api/$project/cron/$MONITOR_SLUG/$key/"
    fi
    ;;
esac

checkin() {
  [ -n "$checkin_url" ] || return 0
  # The URL carries the DSN's key: curl's own errors are discarded, never logged.
  curl -fsS -o /dev/null --max-time 10 "${checkin_url}?check_in_id=${check_in_id}&status=$1" 2>/dev/null \
    || say "the Sentry check-in ($1) could not be sent"
}

# ── Failure handling ──────────────────────────────────────────────
finished=0
uploaded_to=""
on_exit() {
  status=$?
  if [ "$finished" != 1 ]; then
    if [ -n "$uploaded_to" ]; then
      rclone deletefile --log-level ERROR "$uploaded_to" >/dev/null 2>&1 || true
    fi
    checkin error
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap on_exit EXIT
fail() { say "FAILED: $*"; exit 1; }

checkin in_progress

# ── Configuration: fail closed, never echo a value ────────────────
missing=""
for name in BACKUP_DATABASE_URL BACKUP_AGE_RECIPIENT R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET SENTRY_DSN; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || missing="$missing $name"
done
[ -z "$missing" ] || fail "missing required variables:$missing"

[ -n "$checkin_url" ] || fail "SENTRY_DSN is not a valid DSN"
case "$BACKUP_DATABASE_URL" in
  postgres://*@*:5432/* | postgresql://*@*:5432/*) ;;
  *) fail "BACKUP_DATABASE_URL must be a postgres:// URL on port 5432 (the session pooler)" ;;
esac
printf '%s' "$BACKUP_AGE_RECIPIENT" | grep -Eq '^age1[02-9ac-hj-np-z]{58}$' \
  || fail "BACKUP_AGE_RECIPIENT is not an age1… X25519 public key"
printf '%s' "$R2_ACCOUNT_ID" | grep -Eq '^[0-9a-f]{32}$' || fail "R2_ACCOUNT_ID must be 32 hex characters"
printf '%s' "$R2_BUCKET" | grep -Eq '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' || fail "R2_BUCKET is not a valid bucket name"

# rclone reads its remote from the environment: no config file.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:-https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com}"
# The token is scoped to one bucket, so it can't list or create buckets.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

# ── Dump, encrypt, upload ─────────────────────────────────────────
name="ledger-$(date -u +%Y-%m-%dT%H%M%SZ).dump.age"
incoming="r2:$R2_BUCKET/incoming/$name"
daily="r2:$R2_BUCKET/daily/$name"

say "$(pg_dump --version), $(age --version | head -n 1), $(rclone version | head -n 1)"
say "dumping, encrypting and uploading incoming/$name"
uploaded_to="$incoming"
# One pipeline under one timeout. pipefail makes any stage's failure the
# pipeline's; the variables reach the inner shell through the environment, so
# the single quotes are deliberate.
# shellcheck disable=SC2016
timeout "$TIMEOUT_SECONDS" sh -c '
  set -o pipefail
  pg_dump --format=custom --schema=public --no-owner --no-privileges --dbname="$BACKUP_DATABASE_URL" \
    | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" \
    | rclone rcat --log-level ERROR "$1"
' ledger-backup "$incoming" || fail "the dump, its encryption or its upload did not finish"

bytes="$(rclone size --json --log-level ERROR "$incoming" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')"
[ "${bytes:-0}" -ge "$MIN_BYTES" ] || fail "the encrypted dump is only ${bytes:-0} bytes (expected at least $MIN_BYTES)"

rclone moveto --log-level ERROR "$incoming" "$daily" || fail "could not move it to daily/"
uploaded_to=""

finished=1
say "done: daily/$name, $bytes bytes"
checkin ok
