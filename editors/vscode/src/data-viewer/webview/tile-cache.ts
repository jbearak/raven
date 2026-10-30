/**
 * The webview's cell cache: tiles keyed by (row page, column page).
 *
 *   - **Geometry.** A tile is `rowsPerTile` display rows × `colsPerTile`
 *     column positions (positions in the visible-column list, i.e. the
 *     order of cells in fetched rows). Unsorted views use 256-row tiles,
 *     which match the reader's contiguous chunk reads; permuted views
 *     (sort or filter) use 64-row tiles, which match the reader thread's
 *     element gather. Wide frames shrink the row page further so one
 *     viewport request stays a similar number of cells
 *     ({@link tileGeometry}).
 *   - **O(1) lookup.** A cell is found by computing its tile key and one
 *     `Map` lookup, never by scanning windows.
 *   - **Bounded** by cell count and estimated bytes (like table-viewer's
 *     `row-loader.ts`), evicting least-recently-used tiles. Tiles under
 *     the viewport are **pinned** and never evicted, so a burst of
 *     off-screen replies can't blank what's on screen.
 *   - Original row indices (the gutter's R row numbers under a sort or
 *     filter) are kept per row page, shared by that page's tiles.
 *
 * The cache holds one transform generation's rows; the owner clears it
 * when the shown generation changes.
 */
import type { Cell } from '../wire-format';

export type TileGeometry = { rowsPerTile: number; colsPerTile: number };

export const COLS_PER_TILE = 32;

/** Tile geometry for a view: 256 × 32 unsorted, 64 × 32 permuted, with
 *  row pages halved for frames of 512+ visible columns and quartered for
 *  2,048+ (as julia-vscode's table viewer does). */
export function tileGeometry(permuted: boolean, visibleColumns: number): TileGeometry {
    let rows = permuted ? 64 : 256;
    if (visibleColumns >= 2048) rows = Math.max(16, rows / 4);
    else if (visibleColumns >= 512) rows = Math.max(16, rows / 2);
    return { rowsPerTile: rows, colsPerTile: COLS_PER_TILE };
}

type Tile = {
    rowPage: number;
    colPage: number;
    /** `rows[r][c]`: display row `rowPage * R + r`, position `colPage * C + c`. */
    rows: Cell[][];
    cells: number;
    bytes: number;
};

export type TileCacheLimits = { maxCells: number; maxBytes: number };

export const DEFAULT_TILE_LIMITS: TileCacheLimits = {
    maxCells: 400_000,
    maxBytes: 48 * 1024 * 1024,
};

/** Bytes a cell holds, roughly (strings dominate). */
function cellBytes(c: Cell): number {
    if (c === null) return 8;
    if (typeof c === 'number') return 8;
    if (typeof c === 'string') return 16 + 2 * c.length;
    return 48;
}

/** Packs (rowPage, colPage) into one number; colPage < 2^16 always
 *  (2^16 × 32 columns). */
const key = (rowPage: number, colPage: number) => rowPage * 65536 + colPage;

export class TileCache {
    private readonly tiles = new Map<number, Tile>();
    private readonly originals = new Map<number, number[]>();
    private pinned = new Set<number>();
    private cellsHeld = 0;
    private bytesHeld = 0;

    constructor(
        readonly geometry: TileGeometry,
        private readonly limits: TileCacheLimits = DEFAULT_TILE_LIMITS,
    ) {}

    get cells(): number { return this.cellsHeld; }
    get bytes(): number { return this.bytesHeld; }
    get size(): number { return this.tiles.size; }

    /** The cell at display row `row`, column position `pos`. */
    cell(row: number, pos: number): Cell | undefined {
        const { rowsPerTile: R, colsPerTile: C } = this.geometry;
        const t = this.tiles.get(key(Math.floor(row / R), Math.floor(pos / C)));
        if (!t) return undefined;
        return t.rows[row - t.rowPage * R]?.[pos - t.colPage * C];
    }

    /** Whether any tile holds display row `row`. */
    hasRow(row: number): boolean {
        return this.originals.has(Math.floor(row / this.geometry.rowsPerTile));
    }

    /** Original (unpermuted) row index of display row `row`, when its page
     *  was fetched under a permutation. */
    originalRowIndex(row: number): number | undefined {
        const R = this.geometry.rowsPerTile;
        const page = this.originals.get(Math.floor(row / R));
        return page && page.length > 0 ? page[row - Math.floor(row / R) * R] : undefined;
    }

    has(rowPage: number, colPage: number): boolean {
        return this.tiles.has(key(rowPage, colPage));
    }

    /** Pages covering rows `[rowStart, rowEnd)` × positions `[colStart, colEnd)`. */
    pagesFor(rowStart: number, rowEnd: number, colStart: number, colEnd: number): {
        rowPages: [number, number];
        colPages: [number, number];
    } {
        const { rowsPerTile: R, colsPerTile: C } = this.geometry;
        return {
            rowPages: [Math.floor(rowStart / R), Math.floor(Math.max(rowStart, rowEnd - 1) / R)],
            colPages: [Math.floor(colStart / C), Math.floor(Math.max(colStart, colEnd - 1) / C)],
        };
    }

    /** Bounding box of the tiles in the given page ranges that aren't
     *  cached, as display rows × positions; undefined when all are. */
    missing(rowPages: [number, number], colPages: [number, number]): {
        rowPages: [number, number]; colPages: [number, number];
    } | undefined {
        let r0 = Infinity; let r1 = -1; let c0 = Infinity; let c1 = -1;
        for (let r = rowPages[0]; r <= rowPages[1]; r++) {
            for (let c = colPages[0]; c <= colPages[1]; c++) {
                if (this.tiles.has(key(r, c))) continue;
                if (r < r0) r0 = r;
                if (r > r1) r1 = r;
                if (c < c0) c0 = c;
                if (c > c1) c1 = c;
            }
        }
        return r1 < 0 ? undefined : { rowPages: [r0, r1], colPages: [c0, c1] };
    }

    /** Pin exactly the tiles in these page ranges (the viewport). */
    pin(rowPages: [number, number], colPages: [number, number]): void {
        const next = new Set<number>();
        for (let r = rowPages[0]; r <= rowPages[1]; r++) {
            for (let c = colPages[0]; c <= colPages[1]; c++) next.add(key(r, c));
        }
        this.pinned = next;
    }

    /**
     * Store a reply covering display rows `[rowStart, rowStart + rows.length)`
     * and positions `[colStart, colStart + width)`, split into tiles. Only
     * whole tiles are stored (a partial page at the frame's end counts as
     * whole). `originals` are the reply's original row indices, if any.
     */
    putBlock(
        rowStart: number,
        colStart: number,
        rows: Cell[][],
        originals: number[] | undefined,
        totalRows: number,
        totalCols: number,
    ): void {
        const { rowsPerTile: R, colsPerTile: C } = this.geometry;
        const width = rows[0]?.length ?? 0;
        if (rows.length === 0) return;
        const rowEnd = rowStart + rows.length;
        const colEnd = colStart + width;
        for (let rp = Math.floor(rowStart / R); rp * R < rowEnd; rp++) {
            const r0 = rp * R;
            const r1 = Math.min(r0 + R, totalRows);
            if (r0 < rowStart || r1 > rowEnd) continue; // partial page
            if (!this.originals.has(rp)) {
                this.originals.set(rp, originals ? originals.slice(r0 - rowStart, r1 - rowStart) : []);
            }
            for (let cp = Math.floor(colStart / C); cp * C < colEnd; cp++) {
                const c0 = cp * C;
                const c1 = Math.min(c0 + C, totalCols);
                if (c0 < colStart || c1 > colEnd) continue;
                const tileRows: Cell[][] = new Array(r1 - r0);
                let bytes = 0;
                for (let r = r0; r < r1; r++) {
                    const src = rows[r - rowStart];
                    const row = src.slice(c0 - colStart, c1 - colStart);
                    for (const c of row) bytes += cellBytes(c);
                    tileRows[r - r0] = row;
                }
                this.set({ rowPage: rp, colPage: cp, rows: tileRows, cells: (r1 - r0) * (c1 - c0), bytes });
            }
        }
        this.evict();
    }

    private set(t: Tile): void {
        const k = key(t.rowPage, t.colPage);
        const old = this.tiles.get(k);
        if (old) {
            this.cellsHeld -= old.cells;
            this.bytesHeld -= old.bytes;
            this.tiles.delete(k);
        }
        this.tiles.set(k, t);
        this.cellsHeld += t.cells;
        this.bytesHeld += t.bytes;
    }

    /** Mark a tile most recently used (on draw). */
    touch(row: number, pos: number): void {
        const { rowsPerTile: R, colsPerTile: C } = this.geometry;
        const k = key(Math.floor(row / R), Math.floor(pos / C));
        const t = this.tiles.get(k);
        if (!t) return;
        this.tiles.delete(k);
        this.tiles.set(k, t);
    }

    private evict(): void {
        if (this.cellsHeld <= this.limits.maxCells && this.bytesHeld <= this.limits.maxBytes) return;
        for (const [k, t] of this.tiles) {
            if (this.cellsHeld <= this.limits.maxCells && this.bytesHeld <= this.limits.maxBytes) break;
            if (this.pinned.has(k)) continue;
            this.tiles.delete(k);
            this.cellsHeld -= t.cells;
            this.bytesHeld -= t.bytes;
            let pageLive = false;
            for (const other of this.tiles.values()) {
                if (other.rowPage === t.rowPage) { pageLive = true; break; }
            }
            if (!pageLive) this.originals.delete(t.rowPage);
        }
    }

    /** Up to `limit` cached values at position `pos` (width measurement). */
    sampleColumn(pos: number, limit: number): Cell[] {
        const C = this.geometry.colsPerTile;
        const cp = Math.floor(pos / C);
        const out: Cell[] = [];
        for (const t of this.tiles.values()) {
            if (t.colPage !== cp) continue;
            for (const row of t.rows) {
                if (out.length >= limit) return out;
                const c = row[pos - cp * C];
                if (c !== undefined) out.push(c);
            }
        }
        return out;
    }

    /** True once any rows are cached. */
    get hasAny(): boolean { return this.tiles.size > 0; }

    clear(): void {
        this.tiles.clear();
        this.originals.clear();
        this.pinned.clear();
        this.cellsHeld = 0;
        this.bytesHeld = 0;
    }
}
