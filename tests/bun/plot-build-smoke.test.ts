import { describe, test, expect } from 'bun:test';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

describe('plot viewer build outputs', () => {
    const dist = join(__dirname, '..', '..', 'editors', 'vscode', 'dist');

    test('extension bundle exists', () => {
        expect(existsSync(join(dist, 'extension.js'))).toBe(true);
        expect(statSync(join(dist, 'extension.js')).size).toBeGreaterThan(1000);
    });

    test('webview JS bundle exists', () => {
        const p = join(dist, 'webviews', 'plot-viewer', 'index.js');
        expect(existsSync(p)).toBe(true);
        expect(statSync(p).size).toBeGreaterThan(1000);
    });

    test('webview CSS bundle exists', () => {
        const p = join(dist, 'webviews', 'plot-viewer', 'index.css');
        expect(existsSync(p)).toBe(true);
        expect(statSync(p).size).toBeGreaterThan(0);
    });
});
