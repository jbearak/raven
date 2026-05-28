// Bundle the toolbar-wrap real-layout test harness webview. Output goes
// to `dist-test/`, NOT `dist/`, so the harness is never shipped — vsce
// only walks `dist/` for the runtime webviews. Mirrors the esbuild config
// of `buildReactWebview` in `build.js`. Invoked by `bun run
// bundle:webview-test`, which is wired into `pretest` only — `vsce
// package` runs `bun run bundle`, which does NOT touch this.

const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const distTest = path.join(root, 'dist-test');

async function buildHarnessWebview() {
    const entry = path.join(
        root,
        'src',
        'data-viewer',
        'webview',
        'test-harness',
        'index.tsx',
    );
    const outdir = path.join(distTest, 'toolbar-wrap-harness');
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'browser',
        target: 'chrome108',
        format: 'iife',
        // esbuild's CSS loader emits a sibling .css next to the IIFE
        // (`harness-panel.ts` links it like production does).
        loader: { '.css': 'css' },
        sourcemap: true,
        outfile: path.join(outdir, 'index.js'),
        logLevel: 'info',
    });
}

(async () => {
    try {
        await buildHarnessWebview();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
