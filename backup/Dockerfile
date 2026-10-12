# The daily backup job (M7.7): pg_dump 17, age, rclone and curl on Alpine.
# Built by Railway from the repo root (backup/railway.json), and by CI.
#
# pg_dump must be at least the server's major version: production is
# Postgres 17. When Supabase moves to 18, this job fails loudly until
# postgresql17-client here becomes postgresql18-client (docs/backups.md).
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache postgresql17-client age rclone curl ca-certificates

COPY backup/run.sh /usr/local/bin/ledger-backup
RUN chmod 0555 /usr/local/bin/ledger-backup

# Nothing here needs root, or a writable home beyond rclone's cache.
USER nobody
ENV HOME=/tmp

ENTRYPOINT ["/usr/local/bin/ledger-backup"]
