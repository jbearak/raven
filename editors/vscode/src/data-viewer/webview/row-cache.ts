/** LRU of decoded row windows. Bounded by aggregate cell count.
 *
 *  Key is `start:end`; the cache assumes the column subset of a row
 *  window is stable for the panel's lifetime (the webview re-fetches
 *  windows on hide/show, so this is safe). */

import type { Cell } from '../wire-format';

type Entry = {
    start: number;
    end: number;
    rows: Cell[][];
    /** Original 0-based row index per row, when the host sent them (a
     *  sort or filter was active). */
    originalRowIndices?: number[];
    cells: number;
};

export class RowCache {
    private entries = new Map<string, Entry>();
    private cells = 0;

    constructor(private readonly capacity: number) {}

    private k(start: number, end: number): string { return `${start}:${end}`; }

    get(start: number, end: number): Cell[][] | undefined {
        const key = this.k(start, end);
        const e = this.entries.get(key);
        if (!e) return undefined;
        // LRU touch: re-insert moves to MRU position.
        this.entries.delete(key);
        this.entries.set(key, e);
        return e.rows;
    }

    hasRange(start: number, end: number): boolean {
        for (const [key, e] of this.entries) {
            if (start < e.start || end > e.end) continue;
            this.entries.delete(key);
            this.entries.set(key, e);
            return true;
        }
        return false;
    }

    put(start: number, end: number, rows: Cell[][], originalRowIndices?: number[]): void {
        const cells = rows.length * (rows[0]?.length ?? 0);
        const key = this.k(start, end);
        const old = this.entries.get(key);
        if (old) {
            this.cells -= old.cells;
            this.entries.delete(key);
        }
        this.entries.set(key, { start, end, rows, originalRowIndices, cells });
        this.cells += cells;
        while (this.cells > this.capacity && this.entries.size > 0) {
            const first = this.entries.keys().next().value as string;
            const e = this.entries.get(first)!;
            this.cells -= e.cells;
            this.entries.delete(first);
        }
    }

    getRow(row: number): Cell[] | undefined {
        for (const [key, e] of this.entries) {
            if (row < e.start || row >= e.end) continue;
            this.entries.delete(key);
            this.entries.set(key, e);
            return e.rows[row - e.start];
        }
        return undefined;
    }

    /** Original row index of display row `row`, if a cached window
     *  carried one. Undefined means natural order (or not loaded). */
    getOriginalRowIndex(row: number): number | undefined {
        for (const e of this.entries.values()) {
            if (row < e.start || row >= e.end) continue;
            return e.originalRowIndices?.[row - e.start];
        }
        return undefined;
    }

    /** Whether display row `row` is in any cached window. */
    hasRow(row: number): boolean {
        for (const e of this.entries.values()) {
            if (row >= e.start && row < e.end && row - e.start < e.rows.length) return true;
        }
        return false;
    }

    /** Up to `limit` cached rows, in no particular order (for width
     *  measurement). */
    sampleRows(limit: number): Cell[][] {
        const out: Cell[][] = [];
        for (const e of this.entries.values()) {
            for (const row of e.rows) {
                if (out.length >= limit) return out;
                out.push(row);
            }
        }
        return out;
    }

    clear(): void {
        this.entries.clear();
        this.cells = 0;
    }
}
