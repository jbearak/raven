import { describe, test, expect } from 'bun:test';
import { pickPrimaryOutput } from '../../editors/vscode/src/knit/knit-output';

describe('pickPrimaryOutput', () => {
    test('returns the only entry when there is one', () => {
        expect(pickPrimaryOutput(['/a/foo.html'])).toBe('/a/foo.html');
    });

    test('prefers .html when present mid-list', () => {
        expect(pickPrimaryOutput(['/a/foo.pdf', '/a/foo.html', '/a/foo.docx']))
            .toBe('/a/foo.html');
    });

    test('prefers .htm when no .html', () => {
        expect(pickPrimaryOutput(['/a/foo.pdf', '/a/foo.htm'])).toBe('/a/foo.htm');
    });

    test('returns the first when no HTML is present', () => {
        expect(pickPrimaryOutput(['/a/foo.pdf', '/a/foo.docx'])).toBe('/a/foo.pdf');
    });

    test('case-insensitive extension match', () => {
        expect(pickPrimaryOutput(['/a/foo.PDF', '/a/foo.HTML'])).toBe('/a/foo.HTML');
    });

    test('returns undefined for an empty list', () => {
        expect(pickPrimaryOutput([])).toBeUndefined();
    });
});
