/** Single-rectangle selection model.
 *
 *  Tracks an anchor and focus cell. `selectAll` records both an
 *  explicit list of column indices (for non-contiguous visible
 *  columns) and a synthetic anchor/focus that spans them. */

export type Rect = {
    rowStart: number;
    rowEnd: number;
    colStart: number;
    colEnd: number;
};

export class Selection {
    private a: { row: number; col: number } | null = null;
    private f: { row: number; col: number } | null = null;
    private explicitCols: number[] | null = null;

    anchor(row: number, col: number): void {
        this.a = { row, col };
        this.f = { row, col };
        this.explicitCols = null;
    }

    focus(row: number, col: number): void {
        if (!this.a) {
            this.anchor(row, col);
            return;
        }
        this.f = { row, col };
        this.explicitCols = null;
    }

    selectAll(nrow: number, visibleCols: number[]): void {
        if (visibleCols.length === 0) {
            this.clear();
            return;
        }
        const minCol = visibleCols[0];
        const maxCol = visibleCols[visibleCols.length - 1];
        this.a = { row: 0, col: minCol };
        this.f = { row: nrow - 1, col: maxCol };
        this.explicitCols = [...visibleCols];
    }

    clear(): void {
        this.a = null;
        this.f = null;
        this.explicitCols = null;
    }

    rect(): Rect | null {
        if (!this.a || !this.f) return null;
        return {
            rowStart: Math.min(this.a.row, this.f.row),
            rowEnd: Math.max(this.a.row, this.f.row) + 1,
            colStart: Math.min(this.a.col, this.f.col),
            colEnd: Math.max(this.a.col, this.f.col) + 1,
        };
    }

    /** Explicit column index list set by selectAll — used by the
     *  copy path to honor non-contiguous visible columns. Otherwise the
     *  caller derives from rect()'s [colStart, colEnd) span. */
    colIndices(): number[] | null {
        return this.explicitCols ? [...this.explicitCols] : null;
    }
}
