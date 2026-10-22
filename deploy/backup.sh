#!/usr/bin/env bash
#
# Nightly database dump.
#
# The database is the only part of Xnith that cannot be rebuilt from git. The
# image comes from the Dockerfile, the schema from migrations, the register
# from the IEC — but the booth reports filed on election day exist nowhere
# else, and they exist for about fourteen hours.
#
# Run by xnith-backup.timer. Safe to run by hand at any time.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/deploy/xnith/deploy}"
BACKUP_DIR="${BACKUP_DIR:-/home/deploy/xnith/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

cd "$DEPLOY_DIR"
mkdir -p "$BACKUP_DIR"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${BACKUP_DIR}/xnith-${STAMP}.dump"

# -Fc is the custom format: compressed, and pg_restore can read selectively
# from it. -T means no TTY, which matters because this runs with no terminal.
docker compose exec -T db pg_dump -U xnith -d xnith -Fc > "$OUT"

# A zero-length dump is the failure that looks like success. Catch it here
# rather than discovering it during a restore.
if [ ! -s "$OUT" ]; then
  echo "FATAL: dump is empty — not keeping it" >&2
  rm -f "$OUT"
  exit 1
fi

# Sanity floor. A dump of a database holding 4,485 wards and 23,696 stations
# is megabytes, not kilobytes. A suspiciously small one usually means
# pg_dump connected to the wrong database, or an empty one.
BYTES=$(stat -c %s "$OUT")
if [ "$BYTES" -lt 100000 ]; then
  echo "WARNING: dump is only ${BYTES} bytes — check the database is populated" >&2
fi

gzip -f "$OUT"
echo "ok ${OUT}.gz ($(stat -c %s "${OUT}.gz") bytes)"

# Local retention. Keeps a fortnight, which covers the election and the week
# after it.
find "$BACKUP_DIR" -name 'xnith-*.dump.gz' -mtime +"$KEEP_DAYS" -delete

# ---------------------------------------------------------------------------
# WHAT THIS DOES NOT COVER
#
# Result-slip photographs. They live in the `slip-store` volume, not in
# Postgres, so nothing above touches them. The database keeps the path and the
# SHA-256 of each image; if the volume is lost, those rows point at nothing and
# the one piece of evidence that cannot be re-collected is gone.
#
# They are excluded from the dump on purpose - tens of gigabytes would make the
# nightly restore unusable, and the restore is the thing that has to work - but
# excluded is not the same as backed up. Copy the volume separately:
#
#   docker run --rm -v xnith_slip-store:/s -v "$BACKUP_DIR":/b alpine \
#     tar czf /b/slips-$(date -u +%Y%m%d).tar.gz -C /s .
#
# ---------------------------------------------------------------------------
# OFF-BOX COPY — the line between a backup and a false sense of one.
#
# Everything above writes to the same disk as the database. If that disk
# fails, the dumps go with it, and the Contabo snapshot is a point-in-time
# image of the whole VPS rather than a database you can restore selectively.
#
# Configure one of these and uncomment it:
#
#   rclone copy "${OUT}.gz" remote:xnith-backups/
#   scp "${OUT}.gz" user@elsewhere:/backups/
#
# Until this is on, the backups protect against a bad migration or a dropped
# table, and not against losing the machine.
# ---------------------------------------------------------------------------
