#!/bin/sh
# Nightly database dump from the backup sidecar container (docker-compose.yml).
#
# The dump uses the -Fc (custom) format: it is compressed and pg_restore can
# restore it either whole or in parts — plain SQL cannot do that. It is written
# to a temporary file first and only then renamed: a restore must never pick up
# a dump that was cut off mid-write.
#
# Retention is capped by BACKUP_KEEP_DAYS: without a limit the directory grows
# quietly until the disk fills up, and the first to notice is not the backup
# but Postgres next door.
set -eu

: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_KEEP_DAYS:=14}"

while true; do
  stamp=$(date -u +%Y%m%d-%H%M%S)
  target="/backups/${POSTGRES_DB}-${stamp}.dump"
  if pg_dump -h db -U "$POSTGRES_USER" -Fc -f "${target}.part" "$POSTGRES_DB"; then
    mv "${target}.part" "$target"
    echo "backup: took $target"
  else
    # A failed dump is no reason to wait another day in silence: the message
    # goes to the container log, the fragment is removed, and the next attempt
    # happens on schedule.
    echo "backup: pg_dump failed, there is no dump for $stamp" >&2
    rm -f "${target}.part"
  fi
  find /backups -name "${POSTGRES_DB}-*.dump" -mtime "+${BACKUP_KEEP_DAYS}" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
