/**
 * Grid preview harness: the production `App` (real Glide grid, real
 * styles) fed by an in-memory host, for prototyping the canvas header
 * against Glide 6.0.3 (sort slot, label line, missing bar, resize
 * borders) and for theme screenshots. Open `grid-preview.html` from
 * `dist-test/grid-preview/` in a browser; `?theme=light|dark|hc|hcl`
 * picks the VS Code theme kind, `?filter=1` applies a filter, `?sort=1`
 * a two-key sort, `?empty=1` a filter that matches nothing,
 * `?sidebar=1` opens the Columns sidebar with `mpg` expanded,
 * `?summaries=0` turns the Σ band off. Profiles and value counts are
 * computed here from the fixture.
 *
 * Built to `dist-test/` by `bun run bundle:webview-test`; never shipped.
 */

import { createRoot } from 'react-dom/client';
import '@glideapps/glide-data-grid/dist/index.css';
import '../styles.css';
import { App } from '../App';
import type { ColumnSchema } from '../../arrow-reader';
import type { ExtensionToWebview, WebviewToExtension } from '../../messages';
import { encodeTimestampMicros, type Cell } from '../../wire-format';
import { binEdges, binIndex, binsFrom } from '../../histograms';
import { profileKind, type ColumnProfile, type CountedEntry } from '../../profile';
import { quantileType7 } from '../../sketches';

const params = new URLSearchParams(location.search);

/** VS Code's own default token values for each theme kind (a subset). */
const THEMES: Record<string, { bodyClass: string; vars: Record<string, string> }> = {
    dark: {
        bodyClass: 'vscode-dark',
        vars: {
            '--vscode-editor-background': '#1f1f1f', '--vscode-editor-foreground': '#cccccc',
            '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d',
            '--vscode-editorGroupHeader-tabsBackground': '#181818', '--vscode-panel-border': '#2b2b2b',
            '--vscode-editorWidget-border': '#313131', '--vscode-focusBorder': '#0078d4',
            '--vscode-editor-selectionBackground': '#264f78', '--vscode-list-hoverBackground': '#2a2d2e',
            '--vscode-editorWarning-foreground': '#cca700', '--vscode-button-background': '#0078d4',
            '--vscode-button-foreground': '#ffffff', '--vscode-badge-background': '#616161',
            '--vscode-badge-foreground': '#f8f8f8',
        },
    },
    light: {
        bodyClass: 'vscode-light',
        vars: {
            '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#3b3b3b',
            '--vscode-foreground': '#3b3b3b', '--vscode-descriptionForeground': '#3b3b3b',
            '--vscode-editorGroupHeader-tabsBackground': '#f8f8f8', '--vscode-panel-border': '#e5e5e5',
            '--vscode-editorWidget-border': '#c8c8c8', '--vscode-focusBorder': '#005fb8',
            '--vscode-editor-selectionBackground': '#add6ff', '--vscode-list-hoverBackground': '#f2f2f2',
            '--vscode-editorWarning-foreground': '#bf8803', '--vscode-button-background': '#005fb8',
            '--vscode-button-foreground': '#ffffff', '--vscode-badge-background': '#cccccc',
            '--vscode-badge-foreground': '#3b3b3b',
        },
    },
    hc: {
        bodyClass: 'vscode-high-contrast',
        vars: {
            '--vscode-editor-background': '#000000', '--vscode-editor-foreground': '#ffffff',
            '--vscode-foreground': '#ffffff', '--vscode-descriptionForeground': '#ffffff',
            '--vscode-editorGroupHeader-tabsBackground': '#000000', '--vscode-panel-border': '#6fc3df',
            '--vscode-editorWidget-border': '#6fc3df', '--vscode-focusBorder': '#f38518',
            '--vscode-editor-selectionBackground': '#ffffff', '--vscode-editorWarning-foreground': '#ffd700',
            '--vscode-button-background': '#000000', '--vscode-button-foreground': '#ffffff',
        },
    },
    hcl: {
        bodyClass: 'vscode-high-contrast-light',
        vars: {
            '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#292929',
            '--vscode-foreground': '#292929', '--vscode-descriptionForeground': '#292929',
            '--vscode-editorGroupHeader-tabsBackground': '#ffffff', '--vscode-panel-border': '#0f4a85',
            '--vscode-editorWidget-border': '#0f4a85', '--vscode-focusBorder': '#006bbd',
            '--vscode-editor-selectionBackground': '#0f4a85', '--vscode-editorWarning-foreground': '#895503',
        },
    },
};

const theme = THEMES[params.get('theme') ?? 'dark'] ?? THEMES.dark;
document.body.classList.add(theme.bodyClass);
const rootStyle = document.documentElement.style;
for (const [k, v] of Object.entries(theme.vars)) rootStyle.setProperty(k, v);
rootStyle.setProperty('--vscode-font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
rootStyle.setProperty('--vscode-font-size', '13px');
rootStyle.setProperty('--vscode-editor-font-family', 'Menlo, Monaco, "Courier New", monospace');
rootStyle.setProperty('--vscode-editor-font-size', '12px');

// --- Fixture: mtcars-like, with the cases the redesign is about. -------

const CARS = [
    'Mazda RX4', 'Mazda RX4 Wag', 'Datsun 710', 'Hornet 4 Drive', 'Hornet Sportabout', 'Valiant',
    'Duster 360', 'Merc 240D', 'Merc 230', 'Merc 280', 'Merc 280C', 'Merc 450SE', 'Merc 450SL',
    'Merc 450SLC', 'Cadillac Fleetwood', 'Lincoln Continental', 'Chrysler Imperial', 'Fiat 128',
    'Honda Civic', 'Toyota Corolla', 'Toyota Corona', 'Dodge Challenger', 'AMC Javelin',
    'Camaro Z28', 'Pontiac Firebird', 'Fiat X1-9', 'Porsche 914-2', 'Lotus Europa',
    'Ford Pantera L', 'Ferrari Dino', 'Maserati Bora', 'Volvo 142E',
];
const MPG = [21, 21, 22.8, 21.4, 18.7, 18.1, 14.3, 24.4, 22.8, 19.2, 17.8, 16.4, 17.3, 15.2, 10.4,
    10.4, 14.7, 32.4, 30.4, 33.9, 21.5, 15.5, 15.2, 13.3, 19.2, 27.3, 26, 30.4, 15.8, 19.7, 15, 21.4];
const CYL = [6, 6, 4, 6, 8, 6, 8, 4, 4, 6, 6, 8, 8, 8, 8, 8, 8, 4, 4, 4, 4, 8, 8, 8, 8, 4, 4, 4, 8, 6, 8, 4];

const columns: ColumnSchema[] = [
    { name: 'rowname', arrowType: 'Utf8', isInteger: false, dictionaryShipped: false, typeTag: '<chr>', isRowname: true },
    { name: 'mpg', arrowType: 'Float64', isInteger: false, dictionaryShipped: false, typeTag: '<dbl>', variableLabel: 'Miles per (US) gallon', format: '%9.1f' },
    { name: 'cyl', arrowType: 'Float64', isInteger: false, dictionaryShipped: false, typeTag: '<dbl+lbl>', variableLabel: 'Number of cylinders', valueLabels: { 4: 'four', 6: 'six', 8: 'eight' } },
    { name: 'tiny', arrowType: 'Float64', isInteger: false, dictionaryShipped: false, typeTag: '<dbl>' },
    { name: 'n', arrowType: 'Int32', isInteger: true, dictionaryShipped: false, typeTag: '<int>' },
    { name: 'origin', arrowType: 'Dictionary<Int32, Utf8>', isInteger: false, dictionaryShipped: true, dictionary: ['Europe', 'Japan', 'USA'], typeTag: '<fct>' },
    { name: 'note', arrowType: 'Utf8', isInteger: false, dictionaryShipped: false, typeTag: '<chr>', variableLabel: 'Free-text note from the survey interviewer' },
    { name: 'tested_at', arrowType: 'Timestamp<MICROSECOND, America/New_York>', isInteger: false, dictionaryShipped: false, typeTag: '<dttm>', timeZone: 'America/New_York', timeZoneSource: 'column', subsecondDigits: 3 },
    { name: 'flag', arrowType: 'Bool', isInteger: false, dictionaryShipped: false, typeTag: '<lgl>' },
];

const nrow = CARS.length;
function cellFor(col: number, r: number): Cell {
    switch (col) {
        case 0: return CARS[r];
        case 1: return r === 4 ? null : MPG[r];
        case 2: return CYL[r];
        case 3: return r % 7 === 2 ? { _: 'nan' } : r % 5 === 0 ? null : r === 3 ? 4.2e-9 : Math.round(MPG[r] * 137) / 1000;
        case 4: return r === 6 ? null : r * 11;
        case 5: return r % 3;
        case 6: return r === 1 ? '' : r % 4 === 0 ? null : r === 2 ? 'A long free-text answer that runs past the column width and opens in the cell detail view' : `ok ${r}`;
        case 7: return r % 6 === 5 ? null : encodeTimestampMicros(BigInt(Date.UTC(2024, 2, 10, 6, 30) + r * 3_600_500) * 1000n);
        case 8: return r % 9 === 3 ? null : r % 2 === 0;
        default: return null;
    }
}

const filtered = params.get('empty') ? [] : params.get('filter')
    ? Array.from({ length: nrow }, (_, i) => i).filter(i => CYL[i] !== 4) : undefined;
let perm = filtered ?? Array.from({ length: nrow }, (_, i) => i);
if (params.get('sort')) perm = [...perm].sort((a, b) => CYL[b] - CYL[a] || MPG[a] - MPG[b]);
const permuted = !!(params.get('sort') || filtered);

const nullCounts = columns.map((_, c) => {
    let n = 0;
    for (let r = 0; r < nrow; r++) if (cellFor(c, r) === null) n++;
    return n;
});

/** A column's value as a number in the profile's domain, or null/NaN. */
function numberOf(cell: Cell): number | null {
    if (cell === null) return null;
    if (typeof cell === 'number') return cell;
    if (typeof cell === 'object' && cell._ === 'nan') return NaN;
    if (typeof cell === 'object' && cell._ === 'ts') return cell.ms * 1000 + cell.us;
    return null;
}

/** The profile the scan worker would compute, from the fixture. */
function previewProfile(c: number): ColumnProfile {
    const col = columns[c];
    const kind = profileKind(col);
    const cells = Array.from({ length: nrow }, (_, r) => cellFor(c, r));
    const na = cells.filter(x => x === null).length;
    const base = { columnIndex: c, kind, rows: nrow, na, nan: 0 };
    const counted = (key: (x: Cell) => string | number | boolean, label?: (k: string | number | boolean) => string | undefined): CountedEntry[] => {
        const m = new Map<string | number | boolean, number>();
        for (const x of cells) if (x !== null) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
        return [...m].map(([value, count]) => ({ value, count, error: 0, ...(label?.(value) !== undefined ? { label: label(value) } : {}) }))
            .sort((a, b) => b.count - a.count);
    };
    if (kind === 'numeric' || kind === 'date') {
        const all = cells.map(numberOf).filter((x): x is number => x !== null);
        const nan = all.filter(x => Number.isNaN(x)).length;
        const v = all.filter(x => !Number.isNaN(x)).sort((a, b) => a - b);
        const edges = binEdges(v[0], v[v.length - 1], 20);
        const counts = new Float64Array(20);
        for (const x of v) counts[binIndex(x, edges)]++;
        const mean = v.reduce((a, x) => a + x, 0) / v.length;
        const sd = Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (v.length - 1));
        const cellAt = (x: number): Cell => (kind === 'date' ? encodeTimestampMicros(BigInt(x)) : x);
        return {
            ...base, nan, distinct: { value: new Set(v).size, exact: true },
            min: cellAt(v[0]), max: cellAt(v[v.length - 1]), histogram: binsFrom(edges, counts),
            ...(kind === 'numeric' ? {
                mean, sd, infinite: 0,
                quantiles: { p25: quantileType7(v, 0.25), p50: quantileType7(v, 0.5), p75: quantileType7(v, 0.75), exact: true },
            } : { timeZone: col.timeZone }),
        };
    }
    if (kind === 'logical') {
        const t = cells.filter(x => x === true).length;
        const f = cells.filter(x => x === false).length;
        const top = counted(x => x as boolean);
        return { ...base, distinct: { value: top.length, exact: true }, trueCount: t, falseCount: f, top: { values: top, exact: true, approximateOrder: false } };
    }
    if (kind === 'factor' || kind === 'labelled') {
        const dict = col.dictionary;
        const top = counted(x => x as number, k => dict ? dict[k as number] : col.valueLabels?.[String(k)]);
        const declared = dict ? dict.length : Object.keys(col.valueLabels ?? {}).length;
        const levelKeys = dict ? dict.map((_, i) => i) : Object.keys(col.valueLabels ?? {}).map(Number);
        const levels = levelKeys.map(k => ({
            value: k, label: dict ? dict[k] : col.valueLabels?.[String(k)], count: top.find(e => e.value === k)?.count ?? 0, error: 0,
        }));
        return {
            ...base, distinct: { value: top.length, exact: true },
            top: { values: top.slice(0, 10), exact: true, approximateOrder: false },
            levels: { declared, used: top.length, counts: levels },
        };
    }
    const strs = cells.filter((x): x is string => typeof x === 'string');
    const top = counted(x => String(x));
    return {
        ...base, distinct: { value: top.length, exact: true }, emptyStrings: strs.filter(x => x === '').length,
        minLength: Math.min(...strs.map(x => x.length)), maxLength: Math.max(...strs.map(x => x.length)),
        top: { values: top.slice(0, 10), exact: true, approximateOrder: false },
    };
}

function post(msg: ExtensionToWebview): void {
    setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: msg })), 0);
}

const sort = params.get('sort')
    ? { keys: [{ columnIndex: 2, direction: 'desc' as const }, { columnIndex: 1, direction: 'asc' as const }], labelsOnWhenSorted: true }
    : { keys: [], labelsOnWhenSorted: true };
const filter = filtered
    ? {
        entries: [{
            id: 'f1', columnIndex: 2, enabled: true, includeMissing: false,
            predicate: params.get('empty')
                ? { kind: 'numCompare' as const, op: '>' as const, value: 99 }
                : { kind: 'setNotIn' as const, values: [4] },
        }],
        labelsOnWhenFiltered: true,
    }
    : { entries: [], labelsOnWhenFiltered: true };

const vscode = {
    postMessage(msg: WebviewToExtension) {
        if (msg.type === 'webviewReady') {
            post({
                type: 'init', panelGeneration: 1, nrow, columns,
                layout: { columnWidths: {}, hiddenColumns: [] },
                toolbar: { labelsOn: true, formatOn: true, digits: 3, ...(params.get('summaries') === '0' ? { summariesOn: false } : {}) },
                settings: { missingValueStyle: (params.get('missing') as 'foreground' | 'background' | 'none') ?? 'foreground', defaultDigits: 3, persistSort: true, persistFilters: true },
                dictionaries: { 5: ['Europe', 'Japan', 'USA'] }, schemaHash: 'preview', sort, filter,
            });
            if (filtered) {
                post({ type: 'filterApplied', panelGeneration: 1, requestId: 0, filter, nrowFiltered: filtered.length, fromPersistence: true });
            }
            setTimeout(() => post({ type: 'nullCounts', panelGeneration: 1, counts: nullCounts, done: true }), 300);
        } else if (msg.type === 'getRows') {
            const end = Math.min(msg.end, perm.length);
            const rows: Cell[][] = [];
            const original: number[] = [];
            for (let i = msg.start; i < end; i++) {
                const r = perm[i];
                original.push(r);
                rows.push(msg.columns.map(c => cellFor(c, r)));
            }
            post({
                type: 'rows', panelGeneration: 1, requestId: msg.requestId, viewportGeneration: msg.viewportGeneration,
                start: msg.start, end, rows, stale: false, ...(permuted ? { originalRowIndices: original } : {}),
            });
        } else if (msg.type === 'setProfileInterest') {
            // Loading first, then the profiles a moment later, as the
            // scan worker would.
            post({ type: 'profiles', panelGeneration: 1, updates: msg.columns.map(c => [c, { state: 'loading' }]) });
            setTimeout(() => post({
                type: 'profiles', panelGeneration: 1,
                updates: msg.columns.map(c => (c === 6 && params.get('fail')
                    ? [c, { state: 'failed', error: 'could not decode batch 3' }]
                    : [c, { state: 'ready', profile: previewProfile(c) }])),
            }), 400);
        } else if (msg.type === 'getValueCounts') {
            const p = previewProfile(msg.columnIndex);
            const entries = [...(p.top?.values ?? [])];
            if (msg.order === 'asc') entries.reverse();
            post({
                type: 'valueCounts', panelGeneration: 1, requestId: msg.requestId, columnIndex: msg.columnIndex,
                result: {
                    columnIndex: msg.columnIndex, entries, exact: true, approximateOrder: false,
                    distinct: p.distinct, present: p.rows - p.na - p.nan, na: p.na, order: msg.order,
                },
            });
        } else if (msg.type === 'getCellDetail') {
            const v = cellFor(msg.columnIndex, perm[msg.row]);
            post({ type: 'cellDetail', panelGeneration: 1, requestId: msg.requestId, text: typeof v === 'string' ? v : null, truncated: false });
        }
    },
    setState() { /* not persisted in the preview */ },
};

const container = document.getElementById('root');
if (!container) throw new Error('grid preview root not found');
createRoot(container).render(<App vscode={vscode} />);

if (params.get('sidebar')) {
    // Open the sidebar and expand `mpg`, for screenshots.
    setTimeout(() => {
        (document.querySelector('[aria-controls="columns-sidebar"]') as HTMLButtonElement | null)?.click();
        setTimeout(() => {
            (document.querySelector('#columns-sidebar-row-1 .columns-sidebar-disclosure') as HTMLButtonElement | null)?.click();
        }, 300);
    }, 600);
}
