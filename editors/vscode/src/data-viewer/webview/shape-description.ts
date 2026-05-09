/**
 * Build the shape descriptor shown in the data-viewer toolbar
 * (e.g. "data.frame with 12,345 rows and 24 columns").
 *
 * `objectClass` is the slash-joined `class(x)` chain captured by the R
 * bootstrap profile (`raven.object_class` schema metadata). The first
 * segment is used as the noun — for tibbles `tbl_df`, for matrices
 * `matrix`. Falls back to a class-less "{N} rows × {M} columns" when
 * metadata is missing (test fixtures, non-R producers).
 */
export function describeShape(
    objectClass: string | undefined,
    nrow: number,
    ncol: number,
): string {
    const r = nrow.toLocaleString();
    const c = ncol.toLocaleString();
    const noun = primaryClass(objectClass);
    if (!noun) return `${r} rows × ${c} columns`;
    return `${noun} with ${r} rows and ${c} columns`;
}

function primaryClass(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const first = s.split('/')[0]?.trim();
    return first && first.length > 0 ? first : undefined;
}
