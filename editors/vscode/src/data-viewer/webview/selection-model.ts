/** Single-rectangle selection model.
 *
 *  Tracks an anchor and focus cell. `selectAll` records both an
 *  explicit list of column indices (for non-contiguous visible
 *  columns) and a synthetic anchor/focus that spans them.
 *
 *  Each selection also carries a {@link SelectionKind} that records how
 *  the selection began. `'columns'` and `'all'` selections include the
 *  column-name row when copied — matching spreadsheet conventions where
 *  clicking a column letter or the "select all" corner copies headers
 *  along with the data. */

export type Rect = {
    rowStart: number;
    rowEnd: number;
    colStart: number;
    colEnd: number;
};

export type SelectionKind = 'cells' | 'columns' | 'rows' | 'all';

export type CellPosition = { row: number; col: number };

export class Selection {
    private a: { row: number; col: number } | null = null;
    private f: { row: number; col: number } | null = null;
    private explicitCols: number[] | null = null;
    private k: SelectionKind = 'cells';

    /** Set the anchor/focus to a single point. `kind` records how the
     *  selection began ('cells' for a cell click, 'columns' for a column
     *  header click, 'rows' for a row-number click). Subsequent calls to
     *  {@link focus} preserve the kind. */
    anchor(row: number, col: number, kind: SelectionKind = 'cells'): void {
        this.a = { row, col };
        this.f = { row, col };
        this.explicitCols = null;
        this.k = kind;
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
        this.k = 'all';
    }

    clear(): void {
        this.a = null;
        this.f = null;
        this.explicitCols = null;
        this.k = 'cells';
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

    focusCell(): CellPosition | null {
        return this.f ? { ...this.f } : null;
    }

    kind(): SelectionKind { return this.k; }

    /** True iff a copy of this selection should prepend a column-header
     *  row, matching spreadsheet behavior for column / select-all
     *  selections. */
    includesHeader(): boolean {
        return this.k === 'columns' || this.k === 'all';
    }
}
