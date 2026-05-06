// Two-pass esbuild: extension bundle + webview bundle (Svelte).
const path = require('path');
const esbuild = require('esbuild');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sveltePlugin = require('esbuild-svelte').default ?? require('esbuild-svelte');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sveltePreprocess = require('svelte-preprocess').default ?? require('svelte-preprocess');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const webviewDist = path.join(dist, 'webviews', 'plot-viewer');

async function buildExtension() {
    await esbuild.build({
        entryPoints: [path.join(root, 'src', 'extension.ts')],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        external: ['vscode'],
        sourcemap: true,
        outfile: path.join(dist, 'extension.js'),
        logLevel: 'info',
    });
}

async function buildWebview() {
    await esbuild.build({
        entryPoints: [path.join(root, 'src', 'plot', 'webview', 'main.ts')],
        bundle: true,
        platform: 'browser',
        target: 'chrome108',
        format: 'iife',
        mainFields: ['svelte', 'browser', 'module', 'main'],
        conditions: ['svelte', 'browser'],
        plugins: [
            sveltePlugin({
                preprocess: sveltePreprocess(),
                compilerOptions: { css: 'external' },
            }),
        ],
        loader: { '.css': 'css' },
        sourcemap: true,
        outfile: path.join(webviewDist, 'index.js'),
        logLevel: 'info',
    });
}

(async () => {
    try {
        await Promise.all([buildExtension(), buildWebview()]);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
