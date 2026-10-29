// Installs a packaged Raven VSIX into an empty VS Code profile and runs the
// getting-started tutorial test against it. Called by scripts/fresh-install-check.sh.
// Usage: node run.cjs <vsix> <workspace> <work-dir>
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const vscodeDir = path.join(__dirname, '..', '..', 'editors', 'vscode');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} = require(path.join(vscodeDir, 'node_modules', '@vscode', 'test-electron'));

async function main() {
  const [vsix, workspace, work] = process.argv.slice(2);
  const extensionsDir = path.join(work, 'extensions');
  const userDataDir = path.join(work, 'user-data');
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ cachePath: path.join(vscodeDir, '.vscode-test') });
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const install = spawnSync(
    cli,
    [...cliArgs, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--install-extension', vsix],
    { encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (install.status !== 0) throw new Error(`installing ${vsix} failed`);
  const installed = fs.readdirSync(extensionsDir).filter((d) => d.startsWith('jbearak.raven-r-'));
  if (installed.length !== 1) throw new Error(`expected one installed Raven, found: ${installed.join(', ') || 'none'}`);
  console.log(`installed ${installed[0]} into an empty profile`);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: path.join(__dirname, 'stub'),
    extensionTestsPath: path.join(__dirname, 'suite.cjs'),
    // No --disable-extensions: the installed VSIX must load.
    launchArgs: [workspace, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--disable-gpu', '--no-sandbox'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
