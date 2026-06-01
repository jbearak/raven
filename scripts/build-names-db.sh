#!/usr/bin/env bash
# Fetch CRAN + Bioc r-universe JSON, then build names.db via the (network-free)
# raven binary. Used by both the weekly workflow and local seed generation.
# Usage: build-names-db.sh --raven PATH --output PATH [--seed PATH] [--reference-lib DIR] [--work DIR]
set -euo pipefail

RAVEN="" OUT="" SEED="" REF_LIB="" WORK="$(mktemp -d)"
while [ $# -gt 0 ]; do
  case "$1" in
    --raven) RAVEN="$2"; shift 2;;
    --output) OUT="$2"; shift 2;;
    --seed) SEED="$2"; shift 2;;
    --reference-lib) REF_LIB="$2"; shift 2;;
    --work) WORK="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$RAVEN" ] && [ -n "$OUT" ] || { echo "--raven and --output are required" >&2; exit 2; }

for host in cran.r-universe.dev bioc.r-universe.dev; do
  dest="$WORK/runiverse/${host%%.*}"; mkdir -p "$dest"
  curl -sf "https://${host}/api/ls" -o "$WORK/pkglist-${host}.json"
  jq -r '.[]' "$WORK/pkglist-${host}.json" | while read -r pkg; do
    curl -sf "https://${host}/api/packages/${pkg}" -o "${dest}/${pkg}.json" || echo "skip ${host}/${pkg}"
  done
done

args=( packages build-shipped-db
  --runiverse-cran "$WORK/runiverse/cran"
  --runiverse-bioc "$WORK/runiverse/bioc"
  --output "$OUT"
  --snapshot-date "$(date -u +%Y-%m-%d)"
  --source "r-universe+reference" )
[ -n "$SEED" ] && args+=( --seed "$SEED" )
[ -n "$REF_LIB" ] && args+=( --reference-lib "$REF_LIB" )
"$RAVEN" "${args[@]}"
