import { defineConfig } from '@vscode/test-cli';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// macOS Unix domain sockets cap path length at 103 chars. When this repo is
// checked out in a deeply nested worktree (e.g. `.claude/worktrees/<branch>/`)
// the default `.vscode-test/user-data/<ver>-main.sock` path overflows that
// limit and VS Code fails to launch. Pin the user-data dir to a short tmp
// path so the test harness works regardless of repo location. Suffix with
// the test runner's PID so concurrent runs get isolated dirs and stale
// state from earlier runs doesn't leak in.
const userDataDir = join(tmpdir(), `raven-vscode-test-ud-${process.pid}`);
mkdirSync(userDataDir, { recursive: true });

export default defineConfig({
    files: 'out/test/**/*.test.js',
    workspaceFolder: './src/test/fixtures',
    mocha: {
        timeout: 60000
    },
    launchArgs: [
        '--disable-gpu',
        '--no-sandbox',
        '--disable-extensions',
        `--user-data-dir=${userDataDir}`
    ]
});
