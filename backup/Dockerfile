# The daily backup job (M7.7): pg_dump 17, age, rclone and curl on Alpine.
# Built by Railway from the repo root (settings in Railway's UI; see
# docs/backups.md), and by CI.
#
# pg_dump must be at least the server's major version: production is
# Postgres 17. When Supabase moves to 18, this job fails loudly until
# postgresql17-client here becomes postgresql18-client (docs/backups.md).
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

RUN apk add --no-cache postgresql17-client age rclone curl ca-certificates

COPY backup/run.sh /usr/local/bin/ledger-backup
RUN chmod 0555 /usr/local/bin/ledger-backup

# Nothing here needs root, or a writable home beyond rclone's cache.
USER nobody
ENV HOME=/tmp

ENTRYPOINT ["/usr/local/bin/ledger-backup"]
