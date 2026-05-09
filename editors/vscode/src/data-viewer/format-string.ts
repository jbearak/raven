// Source-file format string parser. Only used to decide whether a
// numeric column whose underlying Arrow type is Float* should be
// treated as integer-display (i.e. width.0 form), so the Format toggle
// has no effect on it and we don't render "5" as "5.000".
//
// Conservative — recognizes only well-known integer-display formats:
//
//   Stata    %[-]?w.0f                   e.g. %9.0f, %-12.0f
//   SAS/SPSS NAME?w.D?                   e.g. F8., F8.0, COMMA10.0,
//                                              DOLLAR8., Z3.
//
// Other Stata/SAS/SPSS formats (general %w.0g, scientific E, BEST,
// dates DATE/TIME/DATETIME, etc.) are intentionally NOT recognized:
// they may still show decimals at runtime, or they aren't numeric.

const SAS_SPSS_INTEGER_NAMES: ReadonlySet<string> = new Set([
    '', // bare width (e.g. "8.0") defaults to F format
    'F', 'FIX',
    'COMMA',
    'DOLLAR',
    'Z',
    'N',
    'PERCENT', 'PCT',
]);

export function formatDeclaresInteger(fmt: string | undefined): boolean {
    if (!fmt) return false;
    const t = fmt.trim();
    // Stata: %[-]?w.0f (fixed, zero decimals).
    if (/^%-?\d+\.0f$/.test(t)) return true;
    // SAS / SPSS: <NAME?><width>.<decimals?>
    const m = /^([A-Z]*)(\d+)\.(\d*)$/.exec(t);
    if (!m) return false;
    const name = m[1];
    const decimals = m[3];
    if (!SAS_SPSS_INTEGER_NAMES.has(name)) return false;
    return decimals === '' || decimals === '0';
}
