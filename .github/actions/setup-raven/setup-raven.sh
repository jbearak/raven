#!/usr/bin/env bash
set -euo pipefail

version="${RAVEN_VERSION:-latest}"
release_repository="${RAVEN_RELEASE_REPOSITORY:-jbearak/raven}"

fail() {
  echo "::error::$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required to install Raven"
}

case "$version" in
  latest | v[0-9]*)
    ;;
  *)
    fail "version must be 'latest' or a Raven release tag"
    ;;
esac

runner_os="${RUNNER_OS:-$(uname -s)}"
case "$runner_os" in
  Linux | linux* | GNU/Linux)
    os="linux"
    ;;
  macOS | Darwin | darwin*)
    os="macos"
    ;;
  *)
    fail "unsupported runner OS: ${runner_os}. setup-raven currently supports Linux and macOS runners."
    ;;
esac

runner_arch="${RUNNER_ARCH:-$(uname -m)}"
case "$runner_arch" in
  X64 | x86_64 | amd64)
    arch="x64"
    ;;
  ARM64 | arm64 | aarch64)
    arch="arm64"
    ;;
  *)
    fail "unsupported runner architecture: ${runner_arch}. setup-raven supports x64 and arm64 runners."
    ;;
esac

asset="raven-${os}-${arch}.zip"
if [ "$version" = "latest" ]; then
  release_base="https://github.com/${release_repository}/releases/latest/download"
else
  release_base="https://github.com/${release_repository}/releases/download/${version}"
fi

runner_temp="${RUNNER_TEMP:-/tmp}"
workdir="${runner_temp}/setup-raven-${os}-${arch}-${RANDOM}-${RANDOM}"
extract_dir="${workdir}/extract"
bin_dir="${workdir}/bin"
archive="${workdir}/${asset}"
checksum_file="${workdir}/${asset}.sha256"

mkdir -p "$extract_dir" "$bin_dir"

require_command curl
require_command unzip

echo "Downloading ${asset} from ${release_repository} (${version})"
curl -fsSL --retry 3 --retry-delay 2 -o "$archive" "${release_base}/${asset}"
curl -fsSL --retry 3 --retry-delay 2 -o "$checksum_file" "${release_base}/${asset}.sha256"

expected_checksum="$(awk '{print $1; exit}' "$checksum_file")"
if [ -z "$expected_checksum" ]; then
  fail "empty checksum file for ${asset}"
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$archive" | awk '{print $1; exit}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$archive" | awk '{print $1; exit}')"
else
  fail "sha256sum or shasum is required to verify Raven"
fi

if [ "$actual_checksum" != "$expected_checksum" ]; then
  fail "checksum mismatch for ${asset}: expected ${expected_checksum}, got ${actual_checksum}"
fi

echo "Checksum verified for ${asset}"
unzip -q "$archive" -d "$extract_dir"

binary="${extract_dir}/raven"
if [ ! -f "$binary" ]; then
  binary="$(find "$extract_dir" -type f -name raven -print -quit)"
fi
if [ -z "$binary" ] || [ ! -f "$binary" ]; then
  fail "archive did not contain raven"
fi

cp "$binary" "${bin_dir}/raven"
chmod +x "${bin_dir}/raven"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$bin_dir" >> "$GITHUB_PATH"
fi
export PATH="${bin_dir}:${PATH}"

"${bin_dir}/raven" --version
