// Fails the build when Raven's Glide Data Grid patch
// (patches/@glideapps+glide-data-grid+6.0.3.patch) isn't applied.
//
// `npm ci` applies it through the `postinstall` script
// (`patch-package --error-on-fail`), which already fails the install when
// the patch doesn't apply cleanly. This guard covers the other ways to
// end up with an unpatched grid: a `node_modules` installed before the
// patch existed, `--ignore-scripts`, or a version bump. The data viewer's
// accessible header names, R-row-number row labels, and column auto-fit
// depend on the patch.

const fs = require('fs');
const path = require('path');

const PINNED_VERSION = '6.0.3';
const MARKER = 'raven patch';

function assertGlidePatched(root) {
    const pkgDir = path.join(root, 'node_modules', '@glideapps', 'glide-data-grid');
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    if (version !== PINNED_VERSION) {
        throw new Error(
            `@glideapps/glide-data-grid is ${version}; Raven's patch is pinned to ${PINNED_VERSION}. ` +
            'Regenerate patches/@glideapps+glide-data-grid+*.patch for the new version.');
    }
    const files = [
        'dist/esm/internal/data-grid/data-grid.js',
        'dist/esm/data-editor/data-editor.js',
    ];
    for (const rel of files) {
        if (!fs.readFileSync(path.join(pkgDir, rel), 'utf8').includes(MARKER)) {
            throw new Error(
                `@glideapps/glide-data-grid/${rel} is not patched. ` +
                'Run `npx patch-package --error-on-fail` (or `npm ci`) in editors/vscode.');
        }
    }
}

module.exports = { assertGlidePatched };

if (require.main === module) {
    try {
        assertGlidePatched(path.resolve(__dirname, '..'));
        console.log('Glide Data Grid patch: applied');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
