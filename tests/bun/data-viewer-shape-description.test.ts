import { describe, test, expect } from 'bun:test';
import { describeShape } from '../../editors/vscode/src/data-viewer/webview/shape-description';

describe('describeShape', () => {
    test('plain data.frame', () => {
        expect(describeShape('data.frame', 12345, 24))
            .toBe('data.frame with 12,345 rows and 24 columns');
    });

    test('tibble: uses first class segment (tbl_df)', () => {
        expect(describeShape('tbl_df/tbl/data.frame', 100, 5))
            .toBe('tbl_df with 100 rows and 5 columns');
    });

    test('matrix: uses first class segment', () => {
        expect(describeShape('matrix/array', 3, 4))
            .toBe('matrix with 3 rows and 4 columns');
    });

    test('undefined objectClass: class-less fallback', () => {
        expect(describeShape(undefined, 1234, 56))
            .toBe('1,234 rows × 56 columns');
    });

    test('empty string objectClass: class-less fallback', () => {
        expect(describeShape('', 1234, 56))
            .toBe('1,234 rows × 56 columns');
    });

    test('whitespace-only first segment: class-less fallback', () => {
        expect(describeShape('   /data.frame', 1, 1))
            .toBe('1 rows × 1 columns');
    });

    test('zero rows', () => {
        expect(describeShape('data.frame', 0, 7))
            .toBe('data.frame with 0 rows and 7 columns');
    });

    test('zero columns', () => {
        expect(describeShape('data.frame', 5, 0))
            .toBe('data.frame with 5 rows and 0 columns');
    });

    test('locale formatting: thousands separator on large counts', () => {
        expect(describeShape('data.frame', 1_000_000, 1_000))
            .toBe('data.frame with 1,000,000 rows and 1,000 columns');
    });
});
