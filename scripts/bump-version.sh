#!/bin/bash
set -e

# Release script: bumps version, commits, tags, and pushes.
#
# Usage:
#   ./scripts/bump-version.sh [--dry-run] [patch|minor|preview|major|<version>]
#
# Even minor versions are stable releases, odd minor versions are VS Code
# Marketplace pre-releases (see scripts/release-channel.sh).
#
# Examples:
#   ./scripts/bump-version.sh           # patch bump (default), same channel: 0.24.0 -> 0.24.1
#   ./scripts/bump-version.sh patch     # same as above; 0.23.0 -> 0.23.1 stays pre-release
#   ./scripts/bump-version.sh minor     # next stable minor: 0.23.2 -> 0.24.0
#   ./scripts/bump-version.sh preview   # next pre-release: 0.24.1 -> 0.25.0, 0.25.0 -> 0.25.1
#   ./scripts/bump-version.sh major     # 0.24.0 -> 1.0.0
#   ./scripts/bump-version.sh 2.0.0     # explicit version
#   ./scripts/bump-version.sh --dry-run preview   # print "0.25.0 pre-release" and stop
#
# This script will:
#   1. Validate the working directory is clean and confirm the release channel
#   2. Update version in Cargo.toml and editors/vscode/package.json
#   3. Commit the version bump
#   4. Create and push a git tag (triggers release-build.yml)
#
# After this completes, go to GitHub Actions and manually run
# release-publish.yml with the tag to create the GitHub Release
# (and optionally publish to VS Code Marketplace).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
    echo "Usage: $0 [--dry-run] [patch|minor|preview|major|<version>]"
    echo ""
    echo "  patch     Bump patch version, same channel (default): 0.24.0 -> 0.24.1"
    echo "  minor     Next stable (even) minor: 0.23.2 -> 0.24.0"
    echo "  preview   Next pre-release: 0.24.1 -> 0.25.0, 0.25.0 -> 0.25.1"
    echo "  major     Bump major version: 0.24.0 -> 1.0.0"
    echo "  <version> Explicit X.Y.Z (even minor = stable, odd minor = pre-release)"
    echo "  --dry-run Print the next version and its channel without changing anything"
    echo ""
    echo "Examples:"
    echo "  $0"
    echo "  $0 patch"
    echo "  $0 minor"
    echo "  $0 preview"
    echo "  $0 1.0.0"
    exit 1
}

# Read current version from [workspace.package] in Cargo.toml
VERSION_MATCHES=$(grep -c '^version = ' "$REPO_ROOT/Cargo.toml")
if [ "$VERSION_MATCHES" -ne 1 ]; then
    echo "ERROR: Expected exactly 1 top-level 'version = ' line in Cargo.toml, found $VERSION_MATCHES."
    echo "The Cargo.toml structure may have changed — update this script's version extraction."
    exit 1
fi
CURRENT_VERSION=$(grep '^version = ' "$REPO_ROOT/Cargo.toml" | sed 's/version = "\(.*\)"/\1/')
if [ -z "$CURRENT_VERSION" ]; then
    echo "ERROR: Could not read current version from Cargo.toml"
    exit 1
fi

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN=1
    shift
fi

BUMP="${1:-patch}"

if [ "$BUMP" = "--help" ] || [ "$BUMP" = "-h" ]; then
    usage
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION%%-*}"
case "$BUMP" in
    patch)
        VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
        ;;
    minor)
        # Next even minor: the next stable line.
        VERSION="$MAJOR.$(( (MINOR / 2 + 1) * 2 )).0"
        ;;
    preview)
        # Continue the current pre-release line, or open the next odd minor.
        if [ "$("$SCRIPT_DIR/release-channel.sh" "$CURRENT_VERSION")" = "pre-release" ]; then
            VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
        else
            VERSION="$MAJOR.$(( MINOR % 2 == 1 ? MINOR + 2 : MINOR + 1 )).0"
        fi
        ;;
    major)
        VERSION="$((MAJOR + 1)).0.0"
        ;;
    *)
        VERSION="${BUMP#v}"
        ;;
esac

# Validate the version and classify its release channel
CHANNEL=$("$SCRIPT_DIR/release-channel.sh" "$VERSION")
if [ "$BUMP" = "preview" ] && [ "$CHANNEL" != "pre-release" ]; then
    echo "ERROR: preview bump produced $VERSION, which is a $CHANNEL version."
    echo "Pass an explicit odd-minor version instead."
    exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
    echo "$VERSION $CHANNEL"
    exit 0
fi

TAG="v$VERSION"

# Check for clean working directory
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    echo "ERROR: Working directory is not clean. Commit or stash changes first."
    git -C "$REPO_ROOT" status --short
    exit 1
fi

# Check tag doesn't already exist
if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    echo "ERROR: Tag $TAG already exists."
    exit 1
fi

if [ -t 0 ]; then
    read -r -p "Release $TAG as $CHANNEL? This commits, tags, and pushes. [y/N] " REPLY
    case "$REPLY" in
        y|Y|yes|YES) ;;
        *) echo "Aborted."; exit 1 ;;
    esac
fi

echo "Bumping version to $VERSION ($CHANNEL)..."

# Update workspace Cargo.toml
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" "$REPO_ROOT/Cargo.toml"

# Update Cargo.lock to reflect the new version
cargo update -p raven --manifest-path "$REPO_ROOT/Cargo.toml"

# Update VS Code extension package.json
cd "$REPO_ROOT/editors/vscode"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
cd "$REPO_ROOT"

# docs/cli.md shows real `raven --version` / `raven check --help` output, and
# tests/bun/docs/examples.test.ts checks it against the current version.
sed -i '' \
    -e "s/^raven $CURRENT_VERSION\$/raven $VERSION/" \
    -e "s/^raven check $CURRENT_VERSION /raven check $VERSION /" \
    "$REPO_ROOT/docs/cli.md"

echo "Updated Cargo.toml, Cargo.lock, editors/vscode/package.json, and docs/cli.md"

# Commit, tag, and push
git -C "$REPO_ROOT" add Cargo.toml Cargo.lock editors/vscode/package.json docs/cli.md
if [ -f "$REPO_ROOT/editors/vscode/package-lock.json" ]; then
  git -C "$REPO_ROOT" add editors/vscode/package-lock.json
fi
git -C "$REPO_ROOT" commit -m "chore: bump version to $VERSION"

echo "Creating tag $TAG..."
git -C "$REPO_ROOT" tag "$TAG"

echo "Pushing commit and tag..."
git -C "$REPO_ROOT" push origin
git -C "$REPO_ROOT" push origin "$TAG"

echo ""
echo "Release $TAG ($CHANNEL) initiated!"
echo ""
echo "Next steps:"
echo "  1. Wait for release-build.yml to finish: https://github.com/jbearak/raven/actions"
echo "  2. Run release-publish.yml manually with tag=$TAG"
echo "     (check 'Publish to VS Code Marketplace' if ready)"
