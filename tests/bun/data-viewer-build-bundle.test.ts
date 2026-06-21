import { beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'bun';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

describe('data viewer build bundle', () => {
    const vscode_dir = join(__dirname, '..', '..', 'editors', 'vscode');
    const node_modules = join(vscode_dir, 'node_modules');
    const data_viewer_bundle = join(vscode_dir, 'dist', 'webviews', 'data-viewer', 'index.js');
    const have_node_modules = existsSync(node_modules);

    beforeAll(async () => {
        if (!have_node_modules) {
            console.warn(
                '[data-viewer-build-bundle] skipping build: editors/vscode/node_modules missing. ' +
                'Run `bun install` in editors/vscode to enable this check.',
            );
            return;
        }

        const proc = spawn({
            cmd: ['bun', 'scripts/build.js'],
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

    test.skipIf(!have_node_modules)(
        'uses production React and stays below the data-viewer size budget',
        () => {
            expect(existsSync(data_viewer_bundle)).toBe(true);
            expect(statSync(data_viewer_bundle).size).toBeLessThan(450_000);

            const bundle = readFileSync(data_viewer_bundle, 'utf8');
            expect(bundle).not.toContain('react-dom.development');
            expect(bundle).not.toContain('react.development');
        },
    );
});
