#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/debian/build-deb.sh <version> <amd64|arm64> <raven-binary> <output-dir>

Build a Debian package for an already-built Raven Linux binary.
The Debian package version is <version>-1.
USAGE
  exit 2
}

fail() {
  echo "build-deb: $1" >&2
  exit 1
}

if [ "$#" -ne 4 ]; then
  usage
fi

version="$1"
architecture="$2"
binary="$3"
output_dir="$4"

case "$version" in
  v*) fail "version must not include a leading v: ${version}" ;;
esac
if ! [[ "$version" =~ ^[0-9]+[.][0-9]+[.][0-9]+([+~A-Za-z0-9._-]+)?$ ]]; then
  fail "version must be a Debian-compatible Raven version such as 0.12.0"
fi

case "$architecture" in
  amd64 | arm64) ;;
  *) fail "architecture must be amd64 or arm64, got ${architecture}" ;;
esac

if [ ! -f "$binary" ]; then
  fail "raven binary not found: ${binary}"
fi
if [ ! -x "$binary" ]; then
  fail "raven binary must be executable: ${binary}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
license_file="${repo_root}/LICENSE"
if [ ! -f "$license_file" ]; then
  fail "LICENSE not found at ${license_file}"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}
require_command dpkg-deb

package_version="${version}-1"
package_name="raven_${package_version}_${architecture}.deb"
workdir="$(mktemp -d "${TMPDIR:-/tmp}/raven-deb-${architecture}.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

package_root="${workdir}/package"
mkdir -p \
  "${package_root}/DEBIAN" \
  "${package_root}/usr/bin" \
  "${package_root}/usr/share/doc/raven" \
  "$output_dir"

install -m 0755 "$binary" "${package_root}/usr/bin/raven"
install -m 0644 "$license_file" "${package_root}/usr/share/doc/raven/copyright"

installed_size_kb="$(du -sk "${package_root}/usr" | awk '{print $1}')"

cat > "${package_root}/DEBIAN/control" <<CONTROL
Package: raven
Version: ${package_version}
Section: devel
Priority: optional
Architecture: ${architecture}
Maintainer: Jonathan Marc Bearak <jonathan@bearak.net>
Installed-Size: ${installed_size_kb}
Depends: ca-certificates, curl
Homepage: https://github.com/jbearak/raven
Description: Static analyzer and language server for R
 Raven resolves R scope statically for editor language intelligence and
 headless CI checks.
CONTROL

dpkg-deb --build --root-owner-group "$package_root" "${output_dir}/${package_name}" >/dev/null
echo "${output_dir}/${package_name}"
