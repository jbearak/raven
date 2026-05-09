import { describe, test, expect } from 'bun:test';
import { Selection } from '../../editors/vscode/src/data-viewer/webview/selection-model';

describe('Selection.kind / includesHeader', () => {
    test('default kind is cells; cells do not include header', () => {
        const s = new Selection();
        s.anchor(2, 3);
        expect(s.kind()).toBe('cells');
        expect(s.includesHeader()).toBe(false);
    });

    test('column anchor sets kind to columns and includes header', () => {
        const s = new Selection();
        s.anchor(0, 4, 'columns');
        s.focus(99, 4);
        expect(s.kind()).toBe('columns');
        expect(s.includesHeader()).toBe(true);
    });

    test('row anchor sets kind to rows and does not include header', () => {
        const s = new Selection();
        s.anchor(7, 0, 'rows');
        s.focus(7, 9);
        expect(s.kind()).toBe('rows');
        expect(s.includesHeader()).toBe(false);
    });

    test('selectAll sets kind to all and includes header', () => {
        const s = new Selection();
        s.selectAll(100, [0, 1, 2, 5]);
        expect(s.kind()).toBe('all');
        expect(s.includesHeader()).toBe(true);
        expect(s.colIndices()).toEqual([0, 1, 2, 5]);
    });

    test('focus preserves kind from the most recent anchor', () => {
        const s = new Selection();
        s.anchor(0, 4, 'columns');
        s.focus(50, 4); // drag-extend within columns mode
        expect(s.kind()).toBe('columns');
    });

    test('a new cell anchor switches kind back to cells', () => {
        const s = new Selection();
        s.selectAll(10, [0, 1, 2]);
        expect(s.kind()).toBe('all');
        s.anchor(3, 1); // user clicks a cell
        expect(s.kind()).toBe('cells');
        expect(s.includesHeader()).toBe(false);
    });

    test('clear() resets kind to cells', () => {
        const s = new Selection();
        s.selectAll(5, [0, 1]);
        s.clear();
        expect(s.kind()).toBe('cells');
        expect(s.rect()).toBeNull();
    });

    test('selectAll with no visible columns clears the selection', () => {
        const s = new Selection();
        s.anchor(0, 0, 'columns');
        s.selectAll(10, []);
        expect(s.rect()).toBeNull();
        expect(s.kind()).toBe('cells');
    });
});
