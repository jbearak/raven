#!/bin/bash
set -euo pipefail

# Prints the release channel ("stable" or "pre-release") for a Raven version.
#
# Usage:
#   ./scripts/release-channel.sh <version>    # 0.22.0 or v0.22.0
#
# The VS Code Marketplace accepts only plain major.minor.patch versions, so the
# channel is encoded in the minor number (Microsoft's recommended scheme):
# even minor = stable, odd minor = pre-release. A pre-release user always gets
# the highest version across both channels, so pre-releases must be numbered
# above the current stable release to stay on the pre-release track.
#
# Every odd minor up to 0.21 shipped as stable before this scheme existed, so
# 0.0 through 0.21 stay stable (a 0.21.x hotfix is still a stable release).
# The first pre-release under the scheme is 0.23.0.
#
# Exits non-zero for versions the Marketplace would reject (e.g. 1.0.0-beta.1).
# Shared by scripts/bump-version.sh and the release workflows so they cannot
# disagree about which channel a tag belongs to.

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <version>" >&2
    exit 2
fi

VERSION="${1#v}"

if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "ERROR: Invalid release version: $1" >&2
    echo "Expected X.Y.Z; the VS Code Marketplace rejects suffixes like -beta.1." >&2
    echo "Use an odd minor version for a pre-release instead." >&2
    exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
if (( MAJOR == 0 && MINOR <= 21 )); then
    echo "stable"
elif (( MINOR % 2 == 1 )); then
    echo "pre-release"
else
    echo "stable"
fi
