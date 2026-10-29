/**
 * Glide theme from VS Code's `--vscode-*` CSS variables.
 *
 * Ported from table-viewer's `vscode-theme.ts` (GPL-3.0, same author):
 * the selection fill is `editor.selectionBackground` re-emitted at a fixed
 * alpha (0.35, 0.5 in high contrast) so cell tints such as the NA
 * background stay visible inside a selection; header background is
 * `editorGroupHeader.tabsBackground`; borders `editorWidget.border` →
 * `panel.border`; focus ring `focusBorder`.
 *
 * Fallbacks come from the active theme kind (`body.vscode-light` /
 * `-dark` / `-high-contrast`), never dark-only literals, because inside a
 * webview the variables are ambient and some are routinely unset.
 *
 * The pure half (`buildGridTheme(get, kind)`) takes an injected getter so
 * it is testable without jsdom's partial custom-property support.
 */

import { useEffect, useState } from 'react';
import type { Theme } from '@glideapps/glide-data-grid';

type VarGetter = (name: string) => string;

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

/** Editor font size when VS Code provides none. */
export const DEFAULT_FONT_SIZE_PX = 13;

const SELECTION_TINT_ALPHA = 0.35;
const SELECTION_TINT_ALPHA_HIGH_CONTRAST = 0.5;
/** NA background under `missingValueStyle: 'background'`. */
const MISSING_TINT_ALPHA = 0.12;
/** Zebra: editor background mixed this far toward the foreground. */
const BAND_MIX = 0.04;

type Fallbacks = {
    bg: string;
    fg: string;
    description: string;
    header: string;
    border: string;
    selection: string;
    focus: string;
    hover: string;
    warning: string;
};

const FALLBACKS: Record<ThemeKind, Fallbacks> = {
    dark: {
        bg: '#1e1e1e', fg: '#cccccc', description: '#9d9d9d', header: '#252526',
        border: '#454545', selection: '#264f78', focus: '#007fd4', hover: '#2a2d2e',
        warning: '#cca700',
    },
    light: {
        bg: '#ffffff', fg: '#3b3b3b', description: '#717171', header: '#f3f3f3',
        border: '#e5e5e5', selection: '#add6ff', focus: '#0090f1', hover: '#e8e8e8',
        warning: '#bf8803',
    },
    'high-contrast': {
        bg: '#000000', fg: '#ffffff', description: '#ffffff', header: '#000000',
        border: '#6fc3df', selection: '#ffffff', focus: '#f38518', hover: '#000000',
        warning: '#ffd700',
    },
    'high-contrast-light': {
        bg: '#ffffff', fg: '#292929', description: '#292929', header: '#ffffff',
        border: '#0f4a85', selection: '#0f4a85', focus: '#006bbd', hover: '#ffffff',
        warning: '#895503',
    },
};

const HEX_RE = /^#([0-9a-f]+)$/i;
const RGB_FN_RE = /^rgba?\(([^)]*)\)$/i;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const ALPHA_RE = /^-?\d+(\.\d+)?%?$/;

/** r/g/b from hex or `rgb()`/`rgba()`; any alpha is read and discarded.
 *  Undefined for anything else (named colors, `color-mix()`, blank). */
export function parseRgbChannels(value: string): [number, number, number] | undefined {
    const text = value.trim();
    const hex = HEX_RE.exec(text);
    if (hex) {
        const d = hex[1];
        if (d.length === 3 || d.length === 4) {
            return [0, 1, 2].map(i => Number.parseInt(d[i] + d[i], 16)) as [number, number, number];
        }
        if (d.length === 6 || d.length === 8) {
            return [0, 1, 2].map(i => Number.parseInt(d.slice(i * 2, i * 2 + 2), 16)) as [number, number, number];
        }
        return undefined;
    }
    const fn = RGB_FN_RE.exec(text);
    if (!fn) return undefined;
    const parts = fn[1].split(/[\s,/]+/).filter(p => p.length > 0);
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    if (!parts.slice(0, 3).every(p => DECIMAL_RE.test(p))) return undefined;
    if (parts.length === 4 && !ALPHA_RE.test(parts[3])) return undefined;
    return parts.slice(0, 3).map(p => Math.min(255, Math.max(0, Math.round(Number(p))))) as [number, number, number];
}

/** `color` re-emitted at exactly `alpha`; `fallback` if unparseable. */
export function tintFromColor(color: string, alpha: number, fallback: string): string {
    const rgb = parseRgbChannels(color);
    return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : fallback;
}

/** `a` mixed `t` of the way toward `b`, as an opaque rgb(); `a` verbatim
 *  if either is unparseable. */
export function mixColors(a: string, b: string, t: number): string {
    const ca = parseRgbChannels(a);
    const cb = parseRgbChannels(b);
    if (!ca || !cb) return a;
    const m = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
    return `rgb(${m[0]}, ${m[1]}, ${m[2]})`;
}

export function parseFontSizePx(value: string, fallback = DEFAULT_FONT_SIZE_PX): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Row height that follows the editor font: 24 px at 13 px. */
export function rowHeightFor(fontSizePx: number): number {
    return Math.round(fontSizePx * 1.85);
}

export type GridTheme = {
    /** Base Glide theme for data cells and headers. */
    grid: Partial<Theme>;
    /** Override for NA cells under `missingValueStyle: 'foreground'`. */
    missingFg: Partial<Theme>;
    /** Override for NA cells under `missingValueStyle: 'background'`. */
    missingBg: Partial<Theme>;
    /** NA cells under `missingValueStyle: 'none'`: italic only. */
    missingPlain: Partial<Theme>;
    /** Override for gutter cells (R row numbers). */
    gutter: Partial<Theme>;
    /** Zebra fill for odd display rows; undefined in high contrast,
     *  where borders already separate rows. */
    bandBg?: string;
    /** Row-hover tint, from `list.hoverBackground`. */
    hoverBg: string;
    /** Color of the header missing bar and NA text. */
    missingColor: string;
    /** Header type tag and status-line color. */
    descriptionFg: string;
    fontSizePx: number;
    fontFamily: string;
    kind: ThemeKind;
};

export function buildGridTheme(get: VarGetter, kind: ThemeKind): GridTheme {
    const fb = FALLBACKS[kind];
    const v = (name: string, fallback: string) => get(name).trim() || fallback;
    const highContrast = kind === 'high-contrast' || kind === 'high-contrast-light';

    const editorBg = v('--vscode-editor-background', fb.bg);
    const editorFg = v('--vscode-editor-foreground', v('--vscode-foreground', fb.fg));
    const accent = v('--vscode-focusBorder', fb.focus);
    const accentFg = v('--vscode-list-activeSelectionForeground', editorFg);
    const selectionAlpha = highContrast ? SELECTION_TINT_ALPHA_HIGH_CONTRAST : SELECTION_TINT_ALPHA;
    const selectionFallback = tintFromColor(fb.selection, selectionAlpha, fb.selection);
    const accentLight = tintFromColor(
        v('--vscode-editor-selectionBackground', fb.selection), selectionAlpha, selectionFallback);
    const headerBg = v('--vscode-editorGroupHeader-tabsBackground', fb.header);
    const hoverBg = v('--vscode-list-hoverBackground', fb.hover);
    const border = v('--vscode-editorWidget-border', v('--vscode-panel-border', fb.border));
    const description = v('--vscode-descriptionForeground', fb.description);
    const disabled = v('--vscode-disabledForeground', description);
    const warning = v('--vscode-editorWarning-foreground', fb.warning);
    const fontFamily = v('--vscode-editor-font-family', v('--vscode-font-family', 'monospace'));
    const fontSizePx = parseFontSizePx(v('--vscode-editor-font-size', `${DEFAULT_FONT_SIZE_PX}px`));
    const banded = mixColors(editorBg, editorFg, BAND_MIX);

    const grid: Partial<Theme> = {
        accentColor: accent,
        accentFg,
        accentLight,
        textDark: editorFg,
        textMedium: description,
        textLight: disabled,
        textBubble: editorFg,
        bgIconHeader: headerBg,
        fgIconHeader: editorFg,
        textHeader: editorFg,
        textHeaderSelected: accentFg,
        textGroupHeader: description,
        bgCell: editorBg,
        bgCellMedium: editorBg,
        bgHeader: headerBg,
        bgHeaderHasFocus: hoverBg,
        bgHeaderHovered: hoverBg,
        bgBubble: headerBg,
        bgBubbleSelected: accent,
        bgSearchResult: accentLight,
        borderColor: border,
        horizontalBorderColor: border,
        headerBottomBorderColor: border,
        drilldownBorder: border,
        linkColor: v('--vscode-textLink-foreground', accent),
        fontFamily,
        baseFontStyle: `${fontSizePx}px`,
        headerFontStyle: `600 ${fontSizePx}px`,
        markerFontStyle: `${Math.round(fontSizePx * 0.92)}px`,
        editorFontSize: `${fontSizePx}px`,
        cellHorizontalPadding: Math.round(fontSizePx * 0.62),
        cellVerticalPadding: 3,
    };
    const italic = `italic ${fontSizePx}px`;
    return {
        grid,
        missingFg: { textDark: description, baseFontStyle: italic },
        missingBg: {
            textDark: editorFg,
            baseFontStyle: italic,
            bgCell: tintFromColor(warning, MISSING_TINT_ALPHA, tintFromColor(fb.warning, MISSING_TINT_ALPHA, fb.warning)),
        },
        missingPlain: { baseFontStyle: italic },
        gutter: {
            bgCell: headerBg,
            bgCellMedium: headerBg,
            textDark: description,
            baseFontStyle: `${Math.round(fontSizePx * 0.92)}px`,
        },
        bandBg: highContrast ? undefined : banded,
        hoverBg,
        missingColor: description,
        descriptionFg: description,
        fontSizePx,
        fontFamily,
        kind,
    };
}

export function themeKindOf(body: HTMLElement): ThemeKind {
    const c = body.classList;
    if (c.contains('vscode-high-contrast-light')) return 'high-contrast-light';
    if (c.contains('vscode-high-contrast')) return 'high-contrast';
    if (c.contains('vscode-light')) return 'light';
    return 'dark';
}

/** Glide paints a canvas, so forced colors don't reach it on their own;
 *  read the system colors through the same token path. */
function forcedColorsGetter(base: VarGetter): VarGetter {
    const system: Record<string, string> = {
        '--vscode-editor-background': 'Canvas',
        '--vscode-editor-foreground': 'CanvasText',
        '--vscode-descriptionForeground': 'GrayText',
        '--vscode-focusBorder': 'Highlight',
        '--vscode-editor-selectionBackground': 'Highlight',
        '--vscode-list-activeSelectionForeground': 'HighlightText',
    };
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const resolve = (keyword: string): string => {
        probe.style.color = keyword;
        return getComputedStyle(probe).color;
    };
    const resolved: Record<string, string> = {};
    for (const [name, keyword] of Object.entries(system)) resolved[name] = resolve(keyword);
    probe.remove();
    return name => resolved[name] ?? base(name);
}

function readGridTheme(): GridTheme {
    const style = getComputedStyle(document.documentElement);
    let get: VarGetter = name => style.getPropertyValue(name);
    const forced = typeof window.matchMedia === 'function'
        && window.matchMedia('(forced-colors: active)').matches;
    if (forced) get = forcedColorsGetter(get);
    return buildGridTheme(get, themeKindOf(document.body));
}

/** Current theme, re-read when VS Code switches color themes (it mutates
 *  the body class and the root's inline custom properties). */
export function useGridTheme(): GridTheme {
    const [value, setValue] = useState<GridTheme>(readGridTheme);
    useEffect(() => {
        const update = () => setValue(readGridTheme());
        const observer = new MutationObserver(update);
        const opts: MutationObserverInit = { attributes: true, attributeFilter: ['class', 'style'] };
        observer.observe(document.body, opts);
        observer.observe(document.documentElement, opts);
        const mq = typeof window.matchMedia === 'function'
            ? window.matchMedia('(forced-colors: active)')
            : undefined;
        mq?.addEventListener?.('change', update);
        return () => {
            observer.disconnect();
            mq?.removeEventListener?.('change', update);
        };
    }, []);
    return value;
}
