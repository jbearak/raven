/**
 * Composition of the sort permutation and the filter's surviving rows
 * into the single row order the reader serves.
 *
 * Both inputs are over the ORIGINAL frame: `permutation` (when present)
 * orders all `nrow` rows; `filteredIndices` (when present) lists the
 * surviving rows in original order. The composition keeps the sort's
 * order restricted to the survivors. It costs O(nrow) time and an
 * `nrow`-byte mask, so the panel computes it once per sort/filter change
 * and caches it (see `DataViewerPanel.effectivePermutation`), never per
 * `getRows` or copy.
 *
 * Sorting only the survivors (#328) is deliberately not done here: the
 * panel keeps sort and filter as independent full-frame results so that
 * changing or clearing either one never re-runs the other. That needs
 * per-column sort keys cached over all rows, which arrive with the scan
 * worker (F4).
 */
export function composeEffectivePermutation(
    permutation: Uint32Array | undefined,
    filteredIndices: Uint32Array | undefined,
    nrow: number,
): Uint32Array | undefined {
    if (!filteredIndices) return permutation;
    if (!permutation) return filteredIndices;
    const survives = new Uint8Array(nrow);
    for (let i = 0; i < filteredIndices.length; i++) survives[filteredIndices[i]] = 1;
    const out = new Uint32Array(filteredIndices.length);
    let j = 0;
    for (let i = 0; i < permutation.length; i++) {
        if (survives[permutation[i]]) out[j++] = permutation[i];
    }
    return out;
}
