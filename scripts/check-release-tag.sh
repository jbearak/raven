#!/bin/bash
set -euo pipefail

# Release guard: fails unless a release tag names the workspace version of the
# commit it points at, then prints the tag's release channel.
#
# Usage:
#   ./scripts/check-release-tag.sh <tag> < Cargo.toml
#   git show "refs/tags/v0.24.0^{commit}:Cargo.toml" | ./scripts/check-release-tag.sh v0.24.0
#
# The root Cargo.toml comes on stdin so the caller picks the revision: the
# tagged commit's manifest, which is not always the one in the checkout
# (release-publish.yml runs from the dispatch branch).
#
# The release workflows take the extension, archive, and Debian package version
# from the tag, while `raven --version` reports [workspace.package] version from
# the manifest. A tag pushed without the version bump would otherwise ship a
# release whose server reports the previous version. Both release workflows run
# this before any build or publish step.
#
# Needs python3 >= 3.11 (tomllib), which the GitHub runners provide.

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <tag> < Cargo.toml" >&2
    exit 2
fi

TAG="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$TAG" != v* ]]; then
    echo "ERROR: Release tag must start with 'v': $TAG" >&2
    exit 1
fi

# Rejects tags the Marketplace would refuse, before reading the manifest.
CHANNEL=$("$SCRIPT_DIR/release-channel.sh" "$TAG")

CARGO_VERSION=$(python3 -c '
import sys

try:
    import tomllib
except ImportError:
    sys.exit("ERROR: check-release-tag.sh needs python3 >= 3.11 (tomllib).")

try:
    version = tomllib.load(sys.stdin.buffer)["workspace"]["package"]["version"]
except (tomllib.TOMLDecodeError, KeyError, TypeError) as error:
    sys.exit(f"ERROR: Could not read [workspace.package] version from the Cargo.toml on stdin: {error!r}")
if not isinstance(version, str):
    sys.exit(f"ERROR: [workspace.package] version is not a string: {version!r}")
print(version)
')

if [ "$TAG" != "v$CARGO_VERSION" ]; then
    echo "ERROR: Tag $TAG does not match the workspace version $CARGO_VERSION in Cargo.toml." >&2
    echo "The release would be labelled ${TAG#v} while raven --version reports $CARGO_VERSION." >&2
    echo "Bump the version with ./scripts/bump-version.sh, which commits and tags together." >&2
    exit 1
fi

echo "$CHANNEL"
