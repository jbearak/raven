// Two-pass esbuild: extension bundle + webview bundles (Svelte).
const path = require('path');
const esbuild = require('esbuild');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sveltePlugin = require('esbuild-svelte').default ?? require('esbuild-svelte');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sveltePreprocess = require('svelte-preprocess').default ?? require('svelte-preprocess');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

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

/**
 * Build a Svelte webview bundle.
 *
 * @param {string} name   - Output directory name under dist/webviews/ (e.g. 'plot-viewer').
 * @param {string} entry  - Absolute path to the webview entry point (main.ts).
 */
async function buildSvelteWebview(name, entry) {
    const webviewDist = path.join(dist, 'webviews', name);
    await esbuild.build({
        entryPoints: [entry],
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
        await Promise.all([
            buildExtension(),
            buildSvelteWebview(
                'plot-viewer',
                path.join(root, 'src', 'plot', 'webview', 'main.ts'),
            ),
            buildSvelteWebview(
                'help-viewer',
                path.join(root, 'src', 'help', 'webview', 'main.ts'),
            ),
        ]);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
