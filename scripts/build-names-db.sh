#!/usr/bin/env bash
# Fetch CRAN + Bioc r-universe metadata, then build names.db via the
# (network-free) raven binary. Used by both the weekly workflow and local seed
# generation.
# Usage: build-names-db.sh --raven PATH --output PATH [--seed PATH] [--work DIR]
#
# Fetch strategy — one bulk `/api/dbdump` per universe (2 requests total), not
# ~24,000 per-package requests. See issue #371. The per-package crawl ran 1h+
# and needed a 5% skip tolerance because every request was an independent chance
# to fail; the BSON dump is the single full-coverage artifact (the analogue of
# crates.io's db-dump.tar.gz) and downloads in seconds.
#
# Why the dump and not `/api/packages?stream=true`: on the `cran.r-universe.dev`
# meta-universe that array/stream endpoint returns only the ~3.3k directly-hosted
# packages (~13% of CRAN), silently and deterministically. `/api/dbdump` carries
# all ~24k. The `raven packages build-shipped-db --runiverse-cran/-bioc` flags
# accept the `.bson` dump file directly (a regular file is parsed as a dbdump; a
# directory is still read as per-package JSON — see runiverse.rs).
set -euo pipefail

RAVEN="" OUT="" SEED="" WORK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --raven|--output|--seed|--work)
      [ $# -ge 2 ] || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in
        --raven) RAVEN="$2";;
        --output) OUT="$2";;
        --seed) SEED="$2";;
        --work) WORK="$2";;
      esac
      shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$RAVEN" ] && [ -n "$OUT" ] || { echo "--raven and --output are required" >&2; exit 2; }

# Default to a temp work dir and clean it up on exit; a caller-supplied --work is left intact.
if [ -z "$WORK" ]; then WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT; fi
# Ensure the work dir exists before any `curl -o "$WORK/..."` (mktemp -d already
# created the default; a caller-supplied --work may name a not-yet-existing dir).
mkdir -p "$WORK"

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

# Validate the raven binary up front: the build needs it, and its --version
# feeds the User-Agent below — a missing/broken binary would otherwise surface
# late as a malformed UA (possible 403) or a confusing failure deep in the build.
raven_version="$("$RAVEN" --version 2>/dev/null | awk '{print $NF}')" \
  || { echo "error: --raven binary ($RAVEN) is not runnable" >&2; exit 1; }
[ -n "$raven_version" ] || { echo "error: --raven binary ($RAVEN) is not runnable" >&2; exit 1; }

# Descriptive User-Agent: r-universe's docs set one in every example, and some
# aggregate hosts (e.g. crates.io) 403 default agents. Identify the build.
UA="raven-names-db/${raven_version} (+https://github.com/jbearak/raven)"

# Download $1 to $2, with backoff. curl --retry honors Retry-After on 429/503 and
# retries transient transport/HTTP-5xx failures (--retry-all-errors extends that
# to connection resets); -f turns a 4xx into a non-zero exit (no silent error-page
# body). --speed-limit/--speed-time abort a stalled transfer (< 1 KB/s for 60 s)
# without imposing a fixed --max-time ceiling that a slow-but-progressing 259 MB
# download could trip. --compressed is harmless (BSON doesn't gzip) but future-proof.
fetch() {
  curl -fsSL --compressed -A "$UA" \
    --retry 3 --retry-delay 2 --retry-all-errors \
    --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
    "$1" -o "$2"
}

# Coverage gate. The authoritative check lives in `build-shipped-db`:
# `--runiverse-{cran,bioc}-min` makes the Rust ingester abort unless the parsed
# *distinct* package count meets a floor derived from that universe's `/api/ls`
# count — the real guard against shipping a degraded names.db. (No byte-level
# preflight here: a grep can't tell a top-level `Package` key from a nested one.
# Note the Rust parser only errors on *framing* corruption: a dump truncated
# exactly at a BSON document boundary parses cleanly at EOF, so the distinct-count
# floor is the ONLY thing between a short download and a published-but-incomplete
# names.db.)
#
# The floor is `/api/ls` minus a small ABSOLUTE slack, not a percentage. A
# truncated download drops an absolute number of packages, and so does genuine
# build-vs-listing skew — neither scales with universe size, so a percentage
# tolerance just grows the blind spot on big universes (1% of CRAN's ~24k is
# ~240 packages a clean-prefix truncation could hide). Empirically the dump's
# distinct count equals `/api/ls` exactly, so DUMP_MAX_SHORTFALL only needs to
# absorb the rare handful of packages added/removed between the two snapshots.
DUMP_MAX_SHORTFALL="${DUMP_MAX_SHORTFALL:-25}"
case "$DUMP_MAX_SHORTFALL" in
  '' | *[!0-9]*) echo "error: DUMP_MAX_SHORTFALL must be a non-negative integer (got '$DUMP_MAX_SHORTFALL')" >&2; exit 2 ;;
esac
args=( packages build-shipped-db
  --output "$OUT"
  --snapshot-date "$(date -u +%Y-%m-%d)"
  --source "r-universe+reference" )
for host in cran.r-universe.dev bioc.r-universe.dev; do
  short="${host%%.*}"
  dump="$WORK/${short}.bson"
  ls_json="$WORK/${short}-ls.json"
  fetch "https://${host}/api/dbdump" "$dump"
  fetch "https://${host}/api/ls" "$ls_json"

  # Count names from a downloaded file, not a pipe: curl --retry cannot truncate
  # /dev/stdout, so a retried /api/ls would concatenate response bodies and
  # corrupt the count. Require a JSON array — an error object or HTML 200 → 0 —
  # and coerce any non-numeric jq output to 0 so the guard can't misfire.
  ls_count="$(jq 'if type=="array" then length else 0 end' "$ls_json" 2>/dev/null)" || ls_count=0
  case "$ls_count" in '' | *[!0-9]*) ls_count=0 ;; esac
  [ "$ls_count" -gt 0 ] \
    || { echo "error: ${host}/api/ls did not return a non-empty package array; aborting" >&2; exit 1; }

  # Floor passed to the authoritative Rust gate: the distinct count must be
  # within DUMP_MAX_SHORTFALL of the listing. Pure integer math — no awk/locale.
  min=$(( ls_count - DUMP_MAX_SHORTFALL ))
  # A non-positive floor is meaningless (DUMP_MAX_SHORTFALL >= ls_count). Refuse
  # it early with a clear message; Rust also rejects --runiverse-*-min 0, but
  # failing here keeps the error actionable.
  [ "${min:-0}" -ge 1 ] 2>/dev/null \
    || { echo "error: coverage floor computed as '${min}' (check DUMP_MAX_SHORTFALL='${DUMP_MAX_SHORTFALL}'); aborting" >&2; exit 1; }
  echo "${host}: /api/ls lists ${ls_count} packages (coverage floor ${min})"
  args+=( "--runiverse-${short}" "$dump" "--runiverse-${short}-min" "$min" )
done
[ -n "$SEED" ] && args+=( --seed "$SEED" )
"$RAVEN" "${args[@]}"
