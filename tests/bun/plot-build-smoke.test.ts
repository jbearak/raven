import { describe, test, expect, beforeAll } from 'bun:test';
import { spawn } from 'bun';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

describe('plot viewer build outputs', () => {
    const vscode_dir = join(__dirname, '..', '..', 'editors', 'vscode');
    const dist = join(vscode_dir, 'dist');
    const extension_bundle = join(dist, 'extension.js');
    const webview_js = join(dist, 'webviews', 'plot-viewer', 'index.js');
    const webview_css = join(dist, 'webviews', 'plot-viewer', 'index.css');

    // dist/ is gitignored, so a clean checkout has no artifacts. Build them
    // here so the smoke check is self-contained. If node_modules is also
    // absent (e.g. fresh clone where the user hasn't run `bun install`),
    // skip with a clear message rather than failing opaquely.
    beforeAll(async () => {
        const have_outputs =
            existsSync(extension_bundle) &&
            existsSync(webview_js) &&
            existsSync(webview_css);
        if (have_outputs) return;
        if (!existsSync(join(vscode_dir, 'node_modules'))) {
            console.warn(
                '[plot-build-smoke] skipping build: editors/vscode/node_modules missing. ' +
                'Run `bun install` in editors/vscode to enable this check.',
            );
            return;
        }
        const proc = spawn({
            cmd: ['bun', 'run', 'bundle'],
            cwd: vscode_dir,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const code = await proc.exited;
        if (code !== 0) {
            const out = await new Response(proc.stdout).text();
            const err = await new Response(proc.stderr).text();
            throw new Error(`bundle build failed (exit ${code})\nstdout:\n${out}\nstderr:\n${err}`);
        }
    }, 120_000);

    test.skipIf(!existsSync(join(vscode_dir, 'node_modules')))(
        'extension bundle exists',
        () => {
            expect(existsSync(extension_bundle)).toBe(true);
            expect(statSync(extension_bundle).size).toBeGreaterThan(1000);
        },
    );

    test.skipIf(!existsSync(join(vscode_dir, 'node_modules')))(
        'webview JS bundle exists',
        () => {
            expect(existsSync(webview_js)).toBe(true);
            expect(statSync(webview_js).size).toBeGreaterThan(1000);
        },
    );

    test.skipIf(!existsSync(join(vscode_dir, 'node_modules')))(
        'webview CSS bundle exists',
        () => {
            expect(existsSync(webview_css)).toBe(true);
            expect(statSync(webview_css).size).toBeGreaterThan(0);
        },
    );
});
