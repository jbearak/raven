import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const appSource = readFileSync(
    join(root, 'editors/vscode/src/data-viewer/webview/App.tsx'),
    'utf-8',
);
const stylesSource = readFileSync(
    join(root, 'editors/vscode/src/data-viewer/webview/styles.css'),
    'utf-8',
);

describe('data viewer restore skip affordance', () => {
    test('restore action is explanatory skip text, not a detached Cancel button', () => {
        expect(appSource).toContain('Loading…');
        expect(appSource).toContain('className="restore-skip"');
        expect(appSource).toContain('Skip and show data now');
        expect(appSource).not.toContain('className="restore-cancel"');
        expect(appSource).not.toContain('>Cancel</button>');
    });

    test('restore banner stacks the skip link under its message', () => {
        expect(stylesSource).toContain('.toolbar-restore');
        expect(stylesSource).toContain('flex-direction: column');
        expect(stylesSource).toContain('align-items: flex-start');
        expect(stylesSource).toContain('.restore-skip');
        expect(stylesSource).not.toContain('.restore-cancel');
    });
});
