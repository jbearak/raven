const fs = require('fs');
const path = require('path');

const binDir = path.join(__dirname, '..', 'bin');
const binaryName = process.platform === 'win32' ? 'rlsp.exe' : 'rlsp';
const destBinary = path.join(binDir, binaryName);
const srcBinary = path.join(__dirname, '..', '..', '..', 'target', 'release', binaryName);

if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

// In CI mode, the binary is pre-placed by the workflow
if (fs.existsSync(destBinary)) {
    console.log('rlsp binary already present (CI mode)');
    process.exit(0);
}

if (fs.existsSync(srcBinary)) {
    fs.copyFileSync(srcBinary, destBinary);
    fs.chmodSync(destBinary, 0o755);
    console.log('Bundled rlsp binary');
} else {
    console.error('rlsp binary not found. Run: cargo build --release -p rlsp');
    process.exit(1);
}
