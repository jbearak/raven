/**
 * Canvas column header: fixed-height slots, drawn by `drawDataHeader`.
 *
 *   ┌──────────────────────┐
 *   │ mpg                ▲2│  name (600 weight); sort glyph in a reserved slot
 *   │ <dbl>                │  type tag, description color, ×0.85 size
 *   │ Miles per gallon     │  variable label, italic; only when any column has one
 *   └──────────────────────┘
 *     ▔▔▔▔ missing bar (2 px), proportional to the NA share
 *
 * The sort slot is reserved whether or not the column is sorted, so a
 * name never shifts or hides under the glyph; name and label ellipsize
 * with `…`. Everything drawn here also exists in the DOM: the accessible
 * header name (`headerAccessibleName`) and the hover tooltip
 * (`headerTooltipLines`).
 */

import type { ColumnSchema } from '../arrow-reader';
import { describeTypeTag, displayTypeTag } from '../display-format';
import { fitLeadingText } from './grid-model';

/** Width reserved at the right edge for the sort glyph and priority. */
export const SORT_SLOT_PX = 18;
/** Height of the missing bar along the header's bottom edge. */
export const MISSING_BAR_PX = 2;

export type HeaderMetrics = {
    height: number;
    nameY: number;
    tagY: number;
    labelY: number | undefined;
    nameFontPx: number;
    tagFontPx: number;
    labelFontPx: number;
};

/** Slot positions (baselines are vertical centers) for a header drawn at
 *  `fontSizePx`, with a label line only when `withLabels`. */
export function headerMetrics(fontSizePx: number, withLabels: boolean): HeaderMetrics {
    const nameFontPx = fontSizePx;
    const tagFontPx = Math.round(fontSizePx * 0.85);
    const labelFontPx = Math.round(fontSizePx * 0.92);
    const top = 5;
    const nameLine = Math.round(nameFontPx * 1.35);
    const tagLine = Math.round(tagFontPx * 1.35);
    const labelLine = Math.round(labelFontPx * 1.35);
    const nameY = top + nameLine / 2;
    const tagY = top + nameLine + tagLine / 2;
    const labelY = withLabels ? top + nameLine + tagLine + labelLine / 2 : undefined;
    const height = top + nameLine + tagLine + (withLabels ? labelLine : 0) + 4 + MISSING_BAR_PX;
    return { height, nameY, tagY, labelY, nameFontPx, tagFontPx, labelFontPx };
}

/** NA state of a column for the missing bar: `undefined` before the
 *  header scan has reported (drawn as loading); a `partial` count is a
 *  lower bound while the scan is still running. */
export type MissingInfo = { count: number; total: number; partial?: boolean } | undefined;

export type SortGlyph = { direction: 'asc' | 'desc'; priority: number };

export type HeaderColors = {
    text: string;
    description: string;
    missing: string;
    fontFamily: string;
};

export type HeaderRect = { x: number; y: number; width: number; height: number };

/** True when `x` (canvas px) falls in the header's sort slot. */
export function inSortSlot(rect: HeaderRect, x: number): boolean {
    return x >= rect.x + rect.width - SORT_SLOT_PX - 4 && x <= rect.x + rect.width;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    return fitLeadingText(text, maxWidth, t => ctx.measureText(t).width, '…').text;
}

export function drawDataHeader(
    ctx: CanvasRenderingContext2D,
    rect: HeaderRect,
    metrics: HeaderMetrics,
    colors: HeaderColors,
    col: ColumnSchema,
    sort: SortGlyph | undefined,
    showPriority: boolean,
    missing: MissingInfo,
    padding: number,
): void {
    const x = rect.x + padding;
    const textWidth = rect.width - padding * 2 - SORT_SLOT_PX;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = colors.text;
    ctx.font = `600 ${metrics.nameFontPx}px ${colors.fontFamily}`;
    ctx.fillText(ellipsize(ctx, col.name, textWidth), x, rect.y + metrics.nameY);

    ctx.fillStyle = colors.description;
    ctx.font = `${metrics.tagFontPx}px ${colors.fontFamily}`;
    ctx.fillText(ellipsize(ctx, displayTypeTag(col), rect.width - padding * 2), x, rect.y + metrics.tagY);

    if (metrics.labelY !== undefined && col.variableLabel) {
        ctx.font = `italic ${metrics.labelFontPx}px ${colors.fontFamily}`;
        ctx.fillText(ellipsize(ctx, col.variableLabel, rect.width - padding * 2), x, rect.y + metrics.labelY);
    }

    if (sort) drawSortGlyph(ctx, rect, metrics, colors, sort, showPriority);
    drawMissingBar(ctx, rect, colors.missing, missing);
    ctx.restore();
}

function drawSortGlyph(
    ctx: CanvasRenderingContext2D,
    rect: HeaderRect,
    metrics: HeaderMetrics,
    colors: HeaderColors,
    sort: SortGlyph,
    showPriority: boolean,
): void {
    const size = Math.max(5, Math.round(metrics.nameFontPx * 0.42));
    const slotLeft = rect.x + rect.width - SORT_SLOT_PX - 2;
    const cy = rect.y + metrics.nameY;
    const left = slotLeft + 1;
    ctx.fillStyle = colors.text;
    ctx.globalAlpha = sort.priority === 1 ? 0.9 : 0.6;
    ctx.beginPath();
    if (sort.direction === 'asc') {
        ctx.moveTo(left, cy + size / 2);
        ctx.lineTo(left + size, cy + size / 2);
        ctx.lineTo(left + size / 2, cy - size / 2);
    } else {
        ctx.moveTo(left, cy - size / 2);
        ctx.lineTo(left + size, cy - size / 2);
        ctx.lineTo(left + size / 2, cy + size / 2);
    }
    ctx.closePath();
    ctx.fill();
    if (showPriority) {
        ctx.globalAlpha = 0.85;
        ctx.font = `600 ${Math.round(metrics.tagFontPx * 0.9)}px ${colors.fontFamily}`;
        ctx.fillText(String(sort.priority), left + size + 2, cy);
    }
    ctx.globalAlpha = 1;
}

function drawMissingBar(
    ctx: CanvasRenderingContext2D,
    rect: HeaderRect,
    color: string,
    missing: MissingInfo,
): void {
    const y = rect.y + rect.height - MISSING_BAR_PX - 1;
    const width = rect.width - 1;
    ctx.fillStyle = color;
    if (missing === undefined || missing.partial) {
        // Loading: a faint dashed bar until the null-count scan finishes.
        ctx.globalAlpha = 0.3;
        for (let dx = 0; dx < width; dx += 6) {
            ctx.fillRect(rect.x + dx, y, Math.min(3, width - dx), MISSING_BAR_PX);
        }
        ctx.globalAlpha = missing ? 0.6 : 1;
    }
    if (missing && missing.count > 0 && missing.total > 0) {
        const share = Math.min(1, missing.count / missing.total);
        ctx.fillRect(rect.x, y, Math.max(1, Math.round(width * share)), MISSING_BAR_PX);
    }
    ctx.globalAlpha = 1;
}

/** NA share as the header and tooltip print it. */
export function formatMissingShare(missing: MissingInfo): string | undefined {
    if (!missing || missing.partial || missing.total <= 0) return undefined;
    if (missing.count === 0) return '0% missing';
    const pct = (missing.count / missing.total) * 100;
    const text = pct < 1 ? '<1' : pct > 99 && pct < 100 ? '>99' : String(Math.round(pct));
    return `${text}% missing`;
}

/** Accessible name for a header cell, e.g. "mpg, double, Miles per
 *  gallon, 12% missing, sorted ascending, priority 2". */
export function headerAccessibleName(
    col: ColumnSchema,
    sort: SortGlyph | undefined,
    showPriority: boolean,
    missing: MissingInfo,
): string {
    const parts = [col.name, describeTypeTag(displayTypeTag(col))];
    if (col.variableLabel) parts.push(col.variableLabel);
    const share = formatMissingShare(missing);
    if (share) parts.push(share);
    if (sort) {
        parts.push(`sorted ${sort.direction === 'asc' ? 'ascending' : 'descending'}`);
        if (showPriority) parts.push(`priority ${sort.priority}`);
    }
    return parts.join(', ');
}

/** Hover detail for a header: name, label, R class, source display
 *  format, NA count and share, and the first few value labels. */
export function headerTooltipLines(col: ColumnSchema, missing: MissingInfo): string[] {
    const lines = [`${col.name}  ${displayTypeTag(col)}`];
    if (col.variableLabel) lines.push(col.variableLabel);
    if (col.originalClass) lines.push(`class: ${col.originalClass.split('/').join(', ')}`);
    if (col.format) lines.push(`display format: ${col.format}`);
    if (missing?.partial) {
        lines.push(`NA: at least ${missing.count.toLocaleString('en-US')} (counting…)`);
    } else if (missing) {
        const share = formatMissingShare(missing);
        lines.push(`NA: ${missing.count.toLocaleString('en-US')}${share ? ` (${share})` : ''}`);
    } else {
        lines.push('NA: counting…');
    }
    if (col.valueLabels) {
        const entries = Object.entries(col.valueLabels);
        const shown = entries.slice(0, 5).map(([v, l]) => `${v} = ${l}`);
        if (entries.length > 5) shown.push(`… ${entries.length - 5} more`);
        const kind = col.arrowType.startsWith('Dictionary') ? 'levels' : 'value labels';
        lines.push(`${kind}: ${shown.join('; ')}`);
    }
    return lines;
}
