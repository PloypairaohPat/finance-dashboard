#!/bin/sh
# ─────────────────────────────────────────────────────────────────
#  Restore one backup into an EMPTY database (M7.7). docs/backups.md has the
#  docker command; it runs this inside postgres:17-alpine with:
#    RESTORE_TARGET_URL  the database to restore into (environment)
#    /work               a tmpfs: the decrypted dump lives only in memory
#    $1                  the .dump.age file (a read-only mount)
#  and the age secret key on stdin (paste it, then Enter and Ctrl+D).
#
#  Schema and data together, never data-only: a full restore loads the rows
#  before it creates triggers, so AuditEvent's `at` survives. The dump creates
#  the public schema and comments on it; a target always has public already
#  (Supabase's has its own grants), so those two entries are skipped and
#  nothing in the target is dropped.
# ─────────────────────────────────────────────────────────────────

set -eu
# BusyBox ash has pipefail; this depends on it.
# shellcheck disable=SC3040
set -o pipefail

file="${1:-}"
[ -n "$file" ] && [ -f "$file" ] || { echo "restore: pass the .dump.age file's path inside the container"; exit 1; }
[ -n "${RESTORE_TARGET_URL:-}" ] || { echo "restore: RESTORE_TARGET_URL is not set"; exit 1; }
[ -d /work ] || { echo "restore: mount a tmpfs at /work (docker run --tmpfs /work)"; exit 1; }

tables="$(psql "$RESTORE_TARGET_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "$tables" = 0 ] || { echo "restore: the target's public schema has $tables table(s). Restore only into an empty database."; exit 1; }

command -v age >/dev/null || apk add --no-cache -q age >/dev/null

echo "restore: paste the age secret key, then Enter and Ctrl+D" >&2
age -d -i - -o /work/ledger.dump "$file" || { echo "restore: could not decrypt (the wrong key, or a damaged file). Nothing was restored."; exit 1; }

pg_restore -l /work/ledger.dump | grep -v -E ' (SCHEMA - public|COMMENT - SCHEMA public) ' > /work/list
pg_restore --no-owner --no-privileges --exit-on-error -L /work/list -d "$RESTORE_TARGET_URL" /work/ledger.dump
rm -f /work/ledger.dump /work/list

echo "restore: done. Next: prisma migrate status, then scripts/post-restore-check.ts (docs/backups.md)."
