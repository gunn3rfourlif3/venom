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

# The PUBLIC age key that nightly dumps are encrypted to. Encrypt-only: this
# box cannot read back what it has written, which is the point. Unset means
# no off-box copy is prepared, and the script says so loudly.
AGE_RECIPIENT="${AGE_RECIPIENT:-}"

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
# fails, the dumps go with it, and the Contabo snapshot is an image of the
# whole VPS rather than a database you can restore selectively.
#
# THIS SERVER DOES NOT PUSH. It encrypts a copy and leaves it here; the
# workstation pulls it (deploy/pull-backups.ps1, run by Task Scheduler).
# That direction is deliberate:
#
#   - no SSH server on the home machine, and no port forwarded to it
#   - the VPS holds no credential for the home network
#   - a compromised VPS cannot reach the copies already pulled, so it cannot
#     destroy the backup history along with the live database
#
# The dump is encrypted before it is left anywhere, and not as a formality.
# It contains working credentials, not merely personal data:
#
#   reporter_roster.capture_token  live upload links - anyone holding one can
#                                  file result slips as that marshal
#   session.session_id             live session cookies, stored raw and
#                                  matched directly, usable until they expire
#   phone numbers                  in reporter_roster, booth_report,
#                                  inbound_message, alert_recipient, station
#
# age is used in PUBLIC KEY mode. This box holds only the recipient's public
# key, so a box that is compromised does not hand over its own backup
# history, and the private key never touches the server.
# ---------------------------------------------------------------------------

if [ -z "$AGE_RECIPIENT" ]; then
  echo "WARNING: AGE_RECIPIENT is not set - no encrypted copy was prepared." >&2
  echo "         This dump protects against a bad migration, not against losing the machine." >&2
  exit 0
fi

command -v age >/dev/null || { echo "FATAL: age is not installed" >&2; exit 1; }

ENC="${OUT}.gz.age"
age -r "$AGE_RECIPIENT" -o "$ENC" "${OUT}.gz"

# Refuse to keep something that is not actually an age file. A truncated or
# empty encryption is the worst outcome here: it looks like a backup for
# months and cannot be opened on the day it is needed.
if [ ! -s "$ENC" ] || ! head -c 22 "$ENC" | grep -q 'age-encryption.org'; then
  echo "FATAL: encryption produced something that is not an age file" >&2
  rm -f "$ENC"
  exit 1
fi

# The header check alone would pass a file that starts correctly and then
# stops. This box cannot decrypt to verify properly - that is the whole point
# of public-key mode - but age never shrinks its input, so an encrypted file
# smaller than the plaintext is wrong on its face.
PLAIN_BYTES=$(stat -c %s "${OUT}.gz")
ENC_BYTES=$(stat -c %s "$ENC")
if [ "$ENC_BYTES" -lt "$PLAIN_BYTES" ]; then
  echo "FATAL: encrypted file is ${ENC_BYTES} bytes against ${PLAIN_BYTES} plaintext - truncated" >&2
  rm -f "$ENC"
  exit 1
fi

echo "encrypted ${ENC} ($(stat -c %s "$ENC") bytes) - awaiting pull"

# Encrypted copies are kept a little longer than the plain ones, because they
# are the ones that leave. Still bounded: this is not an archive.
find "$BACKUP_DIR" -name 'xnith-*.dump.gz.age' -mtime +"$((KEEP_DAYS * 2))" -delete
