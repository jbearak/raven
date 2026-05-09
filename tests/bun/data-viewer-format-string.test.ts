import { describe, test, expect } from 'bun:test';
import { formatDeclaresInteger } from '../../editors/vscode/src/data-viewer/format-string';

describe('formatDeclaresInteger — Stata', () => {
    test('%9.0f → integer', () => {
        expect(formatDeclaresInteger('%9.0f')).toBe(true);
    });
    test('%-12.0f (left-aligned) → integer', () => {
        expect(formatDeclaresInteger('%-12.0f')).toBe(true);
    });
    test('%9.2f → not integer', () => {
        expect(formatDeclaresInteger('%9.2f')).toBe(false);
    });
    test('%9.0g (general) → not integer', () => {
        expect(formatDeclaresInteger('%9.0g')).toBe(false);
    });
    test('%9.0e (scientific) → not integer', () => {
        expect(formatDeclaresInteger('%9.0e')).toBe(false);
    });
});

describe('formatDeclaresInteger — SAS / SPSS', () => {
    test('F8.0 → integer', () => {
        expect(formatDeclaresInteger('F8.0')).toBe(true);
    });
    test('F8. (no explicit decimal) → integer', () => {
        expect(formatDeclaresInteger('F8.')).toBe(true);
    });
    test('F8.2 → not integer', () => {
        expect(formatDeclaresInteger('F8.2')).toBe(false);
    });
    test('COMMA10.0 → integer', () => {
        expect(formatDeclaresInteger('COMMA10.0')).toBe(true);
    });
    test('COMMA10.2 → not integer', () => {
        expect(formatDeclaresInteger('COMMA10.2')).toBe(false);
    });
    test('DOLLAR8. → integer', () => {
        expect(formatDeclaresInteger('DOLLAR8.')).toBe(true);
    });
    test('Z3. → integer', () => {
        expect(formatDeclaresInteger('Z3.')).toBe(true);
    });
    test('PERCENT8.0 → integer', () => {
        expect(formatDeclaresInteger('PERCENT8.0')).toBe(true);
    });
    test('bare width "8.0" → integer (defaults to F)', () => {
        expect(formatDeclaresInteger('8.0')).toBe(true);
    });
    test('BEST12. → not integer (best-fit may show decimals)', () => {
        expect(formatDeclaresInteger('BEST12.')).toBe(false);
    });
    test('BEST12.0 → not integer', () => {
        expect(formatDeclaresInteger('BEST12.0')).toBe(false);
    });
    test('DATE9. → not integer (date format)', () => {
        expect(formatDeclaresInteger('DATE9.')).toBe(false);
    });
    test('DATETIME20. → not integer', () => {
        expect(formatDeclaresInteger('DATETIME20.')).toBe(false);
    });
    test('TIME8. → not integer', () => {
        expect(formatDeclaresInteger('TIME8.')).toBe(false);
    });
    test('E12.4 → not integer (scientific)', () => {
        expect(formatDeclaresInteger('E12.4')).toBe(false);
    });
});

describe('formatDeclaresInteger — edge cases', () => {
    test('undefined → false', () => {
        expect(formatDeclaresInteger(undefined)).toBe(false);
    });
    test('empty string → false', () => {
        expect(formatDeclaresInteger('')).toBe(false);
    });
    test('whitespace tolerated', () => {
        expect(formatDeclaresInteger('  F8.0  ')).toBe(true);
    });
    test('garbage → false', () => {
        expect(formatDeclaresInteger('not a format')).toBe(false);
    });
    test('lowercase SAS-style → false (we expect uppercase)', () => {
        // SAS/SPSS format strings come back uppercase from haven; lowercase
        // would indicate something unexpected.
        expect(formatDeclaresInteger('f8.0')).toBe(false);
    });
});
