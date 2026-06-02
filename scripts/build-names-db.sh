#!/usr/bin/env bash
# Fetch CRAN + Bioc r-universe JSON, then build names.db via the (network-free)
# raven binary. Used by both the weekly workflow and local seed generation.
# Usage: build-names-db.sh --raven PATH --output PATH [--seed PATH] [--work DIR]
set -euo pipefail

RAVEN="" OUT="" SEED="" WORK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --raven) RAVEN="$2"; shift 2;;
    --output) OUT="$2"; shift 2;;
    --seed) SEED="$2"; shift 2;;
    --work) WORK="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$RAVEN" ] && [ -n "$OUT" ] || { echo "--raven and --output are required" >&2; exit 2; }

# Default to a temp work dir and clean it up on exit; a caller-supplied --work is left intact.
if [ -z "$WORK" ]; then WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT; fi

SKIP_COUNT=0 TOTAL_COUNT=0 FAIL_THRESHOLD="${FAIL_THRESHOLD:-0.05}"
for host in cran.r-universe.dev bioc.r-universe.dev; do
  dest="$WORK/runiverse/${host%%.*}"; mkdir -p "$dest"
  curl -sf "https://${host}/api/ls" -o "$WORK/pkglist-${host}.json"
  # Process substitution (not a pipe) keeps SKIP_COUNT/TOTAL_COUNT in this shell.
  while read -r pkg; do
    TOTAL_COUNT=$((TOTAL_COUNT + 1))
    curl -sf "https://${host}/api/packages/${pkg}" -o "${dest}/${pkg}.json" \
      || { echo "skip ${host}/${pkg}" >&2; SKIP_COUNT=$((SKIP_COUNT + 1)); }
  done < <(jq -r '.[]' "$WORK/pkglist-${host}.json")
done
if [ "$TOTAL_COUNT" -gt 0 ] && awk "BEGIN{exit !($SKIP_COUNT/$TOTAL_COUNT > $FAIL_THRESHOLD)}"; then
  echo "error: $SKIP_COUNT/$TOTAL_COUNT package fetches failed (> $FAIL_THRESHOLD); aborting" >&2
  exit 1
fi

args=( packages build-shipped-db
  --runiverse-cran "$WORK/runiverse/cran"
  --runiverse-bioc "$WORK/runiverse/bioc"
  --output "$OUT"
  --snapshot-date "$(date -u +%Y-%m-%d)"
  --source "r-universe+reference" )
[ -n "$SEED" ] && args+=( --seed "$SEED" )
"$RAVEN" "${args[@]}"
