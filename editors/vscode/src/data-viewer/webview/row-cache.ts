/** LRU of decoded row windows. Bounded by aggregate cell count.
 *
 *  Key is `start:end`; the cache assumes the column subset of a row
 *  window is stable for the panel's lifetime (the webview re-fetches
 *  windows on hide/show, so this is safe). */

import type { Cell } from '../wire-format';

type Entry = {
    rows: Cell[][];
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

    put(start: number, end: number, rows: Cell[][]): void {
        const cells = rows.length * (rows[0]?.length ?? 0);
        const key = this.k(start, end);
        const old = this.entries.get(key);
        if (old) {
            this.cells -= old.cells;
            this.entries.delete(key);
        }
        this.entries.set(key, { rows, cells });
        this.cells += cells;
        while (this.cells > this.capacity && this.entries.size > 0) {
            const first = this.entries.keys().next().value as string;
            const e = this.entries.get(first)!;
            this.cells -= e.cells;
            this.entries.delete(first);
        }
    }

    clear(): void {
        this.entries.clear();
        this.cells = 0;
    }
}
