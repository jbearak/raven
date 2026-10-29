#!/usr/bin/env bash
# Fresh-install check for the getting-started tutorial (docs/getting-started.md).
#
# Packages the VS Code extension into a VSIX, installs it into an empty VS Code
# profile on a machine with no R and no `raven` on PATH, and runs the tutorial
# test (editors/vscode/src/test-getting-started/getting-started.test.ts)
# against that installed extension. This proves the tutorial works for someone
# who has just installed Raven from the Marketplace.
#
# Requires: a release build at target/release/raven, `npm ci` in
# editors/vscode, bun, and a display (use `xvfb-run -a` on Linux).
# Set FRESH_INSTALL_ALLOW_R=1 to run on a machine that has R (the run then no
# longer proves the no-R claim).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
ext="$repo/editors/vscode"

if [[ "${FRESH_INSTALL_ALLOW_R:-}" != "1" ]]; then
  for r in "$(command -v R || true)" /usr/bin/R /usr/local/bin/R /opt/homebrew/bin/R /Library/Frameworks/R.framework/Resources/bin/R; do
    if [[ -n "$r" && -x "$r" ]]; then
      echo "R is installed at $r; this check must run without R (or set FRESH_INSTALL_ALLOW_R=1)." >&2
      exit 1
    fi
  done
fi
if command -v raven >/dev/null 2>&1; then
  echo "raven is on PATH ($(command -v raven)); the tutorial assumes it isn't." >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/raven-fresh-install.XXXXXX")"
workspace="$work/tutorial"
mkdir -p "$workspace"
cp "$repo/docs/examples/snippets/getting-started-before/"*.R "$workspace/"

cd "$ext"
bun run package
vsix="$(ls -t "$ext"/*.vsix | head -n 1)"
echo "VSIX: $vsix ($(shasum -a 256 "$vsix" | cut -d' ' -f1))"
bun run compile:test

node "$repo/scripts/fresh-install/run.cjs" "$vsix" "$workspace" "$work"
echo "fresh-install check passed"
