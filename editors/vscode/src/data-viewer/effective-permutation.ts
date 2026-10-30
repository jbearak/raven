/**
 * Composition of a sort permutation and a filter's surviving rows into
 * the single row order the reader serves.
 *
 * Both inputs are over the ORIGINAL frame: `permutation` (when present)
 * orders all `nrow` rows; `filteredIndices` (when present) lists the
 * surviving rows in original order. The composition keeps the sort's
 * order restricted to the survivors, in O(nrow) time and an `nrow`-byte
 * mask.
 *
 * The scan worker doesn't use this: it sorts only the survivors from its
 * cached keys (#328, `scan-core.ts`). The panel uses it only to install a
 * descriptor of state the worker didn't compute (`descriptorFromHostState`).
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
