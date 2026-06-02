const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const binDir = path.join(__dirname, '..', 'bin');
const binaryName = process.platform === 'win32' ? 'raven.exe' : 'raven';
const destBinary = path.join(binDir, binaryName);
const repoRoot = path.join(__dirname, '..', '..', '..');
const srcBinary = path.join(repoRoot, 'target', 'release', binaryName);

if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

// The Tier 3 sidecar (names.db) is deliberately NOT bundled into the VSIX (it
// is also excluded in .vscodeignore). VS Code users run alongside their local R
// install, so Tier 1 resolves their installed packages directly — they don't
// need the broad CRAN/Bioconductor floor, and it would only bloat the VSIX.

// In CI mode, the binary is pre-placed by the workflow. Check for both names
// since cross-platform CI (e.g. packaging win32 on Linux) means
// process.platform won't match the target platform.
if (fs.existsSync(destBinary) || fs.existsSync(path.join(binDir, 'raven')) || fs.existsSync(path.join(binDir, 'raven.exe'))) {
    console.log('raven binary already present (CI mode)');
    process.exit(0);
}

function copyAndChmod() {
    fs.copyFileSync(srcBinary, destBinary);
    fs.chmodSync(destBinary, 0o755);
    console.log('Bundled raven binary');
}

if (fs.existsSync(srcBinary)) {
    copyAndChmod();
    process.exit(0);
}

// No pre-bundled binary, no target/release build. Try cargo build before
// giving up — this is what dev / pretest needs so `bun run pretest` can
// produce a working LSP without the developer remembering to run cargo
// manually. `RAVEN_BUNDLE_NO_BUILD=1` opts out for environments that
// must not invoke cargo (e.g. CI release pipelines that build the binary
// in a separate step).
if (process.env.RAVEN_BUNDLE_NO_BUILD === '1') {
    console.error('raven binary not found and RAVEN_BUNDLE_NO_BUILD=1 — refusing to build. Run: cargo build --release -p raven');
    process.exit(1);
}

console.log(`raven binary not found at ${srcBinary}; running "cargo build --release -p raven"…`);
const result = spawnSync('cargo', ['build', '--release', '-p', 'raven'], {
    cwd: repoRoot,
    stdio: 'inherit',
});

if (result.error && result.error.code === 'ENOENT') {
    console.error('cargo not found in PATH. Install Rust (https://rustup.rs) or set RAVEN_BUNDLE_NO_BUILD=1 and provide a pre-built binary.');
    process.exit(1);
}
if (result.status !== 0) {
    console.error(`cargo build --release -p raven failed (exit ${result.status}).`);
    process.exit(result.status || 1);
}

if (!fs.existsSync(srcBinary)) {
    console.error(`cargo build succeeded but ${srcBinary} is missing. This is a build-script bug.`);
    process.exit(1);
}

copyAndChmod();
