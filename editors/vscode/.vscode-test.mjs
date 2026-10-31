import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS Unix domain sockets cap path length at 103 chars. When this repo is
// checked out in a deeply nested worktree (e.g. `.claude/worktrees/<branch>/`)
// the default `.vscode-test/user-data/<ver>-main.sock` path overflows that
// limit and VS Code fails to launch. Pin the user-data dir to a short tmp
// path so the test harness works regardless of repo location. Suffix with
// the test runner's PID so concurrent runs get isolated dirs and stale
// state from earlier runs doesn't leak in.
const userDataDir = join(tmpdir(), `raven-vscode-test-ud-${process.pid}`);
mkdirSync(join(userDataDir, 'User'), { recursive: true });
// `raven.rTerminal.program` defaults to `ask`, which opens a quick pick on
// the first send and would stall every suite that sends code. Pin Raven's
// console at the user level; suites that change it restore this value, and
// `send-to-r/console-picker.test.ts` covers `ask`.
writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ 'raven.rTerminal.program': 'raven' }, null, 4),
);

// The getting-started suite opens a temp copy of the tutorial's files, outside
// the repo, so no raven.toml or .lintr above it (such as the shared fixtures'
// raven.toml) can change what the tutorial promises. See
// src/test-getting-started/getting-started.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const gettingStartedWs = join(tmpdir(), `raven-getting-started-${process.pid}`);
rmSync(gettingStartedWs, { recursive: true, force: true });
cpSync(join(here, '..', '..', 'docs', 'examples', 'snippets', 'getting-started-before'), gettingStartedWs, {
    recursive: true,
    filter: (src) => !/(^|\/)(cmd|stdout\.txt|stderr\.txt|exit)$/.test(src),
});
const gettingStartedUserData = join(tmpdir(), `raven-vscode-test-gs-${process.pid}`);
mkdirSync(gettingStartedUserData, { recursive: true });

export default defineConfig([
    {
        label: 'main',
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
    },
    {
        label: 'getting-started',
        files: 'out/test-getting-started/**/*.test.js',
        workspaceFolder: gettingStartedWs,
        mocha: {
            timeout: 60000
        },
        launchArgs: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-extensions',
            `--user-data-dir=${gettingStartedUserData}`
        ]
    }
]);
