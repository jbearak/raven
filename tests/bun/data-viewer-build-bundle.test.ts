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
            // ~423 KB before column summaries; the band, the Columns
            // sidebar and value counts add ~28 KB.
            expect(statSync(data_viewer_bundle).size).toBeLessThan(480_000);

            const bundle = readFileSync(data_viewer_bundle, 'utf8');
            expect(bundle).not.toContain('react-dom.development');
            expect(bundle).not.toContain('react.development');
        },
    );
});

describe('data viewer worker threads in dist', () => {
    const vscode_dir = join(__dirname, '..', '..', 'editors', 'vscode');
    const have_node_modules = existsSync(join(vscode_dir, 'node_modules'));
    const dist = join(vscode_dir, 'dist');
    const threads = ['data-viewer-reader.js', 'data-viewer-worker.js'];

    test('the build script bundles both thread entries into dist/', () => {
        const build = readFileSync(join(vscode_dir, 'scripts', 'build.js'), 'utf8');
        expect(build).toContain('buildDataViewerThreads()');
        for (const t of threads) expect(build).toContain(`'${t}'`);
    });

    test('.vscodeignore keeps the thread bundles in the VSIX', () => {
        const ignore = readFileSync(join(vscode_dir, '.vscodeignore'), 'utf8')
            .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        // dist/ ships except the explicitly excluded subtrees; none of them
        // may cover the thread bundles.
        for (const rule of ignore) {
            for (const t of threads) {
                const glob = new Bun.Glob(rule);
                expect(glob.match(`dist/${t}`)).toBe(false);
            }
        }
    });

    test.skipIf(!have_node_modules)('both bundles exist after the build and run as workers', async () => {
        for (const t of threads) expect(existsSync(join(dist, t))).toBe(true);
        const { WorkerEngine } = await import('../../editors/vscode/src/data-viewer/worker-engine');
        const fixture = join(vscode_dir, 'test-fixtures', 'data-viewer', 'tiny.arrow');
        const engine = await WorkerEngine.start({
            filePath: fixture,
            nrow: 5,
            readerScript: join(dist, 'data-viewer-reader.js'),
            scanScript: join(dist, 'data-viewer-worker.js'),
        });
        try {
            const t = await engine.compute({
                sort: { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true },
            });
            expect(await engine.coordinator.install(t)).toBe(true);
            const rows = await engine.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: 1 }, t.gen);
            expect(rows.rows.map(r => r[0])).toEqual([5, 4, 3, 2, 1]);
        } finally {
            await engine.dispose();
        }
    }, 30_000);
});
