/**
 * Canvas drawing of the header summary band (the Σ toggle), 28 px under
 * the header text:
 *
 *   numeric, date, datetime   ▁▂▅█▆▃▁  12% NA · 31     20-bin sparkline
 *   factor, labelled, chr     █ ▆ ▃ ▂ ▁  3% NA · 4     top 5 values
 *   logical                   ███▒▒▒░  5% NA · 2      TRUE / FALSE / NA
 *
 * Loading draws a faint placeholder (the shimmer), a failed profile draws
 * `—` (its error is in the tooltip), never the loading state. Geometry
 * and hit-testing live in `summary-model.ts` so the drawing, the click
 * handling and the tooltip agree on where each bar is. Everything drawn
 * here is also in the Columns sidebar's DOM.
 */
import type { ProfileState } from '../profile';
import {
    BAND_PX,
    bandChart,
    bandGeometry,
    bandText,
    barSlot,
    chartArea,
    chartSlots,
    type BandRect,
} from './summary-model';

export type BandColors = {
    /** Bars and text. */
    fg: string;
    /** Brushed bins. */
    accent: string;
    missing: string;
    fontFamily: string;
    fontPx: number;
};

/** The band's drawable area inside a header cell, given the band slot's
 *  top (`bandY`, relative to the header) and the cell padding. */
export function bandRect(rect: BandRect, bandY: number, padding: number): BandRect {
    return { x: rect.x + padding, y: rect.y + bandY + 3, width: rect.width - padding * 2, height: BAND_PX - 8 };
}

/** The band's text font (also used to measure it for hit-testing). */
export function bandFont(colors: Pick<BandColors, 'fontFamily' | 'fontPx'>): string {
    return `${colors.fontPx}px ${colors.fontFamily}`;
}

export function drawSummaryBand(
    ctx: CanvasRenderingContext2D,
    band: BandRect,
    state: ProfileState | undefined,
    colors: BandColors,
    brush: [number, number] | undefined,
): void {
    if (!state) return;
    ctx.save();
    ctx.font = bandFont(colors);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const midY = band.y + band.height / 2;
    if (state.state === 'loading') {
        // Shimmer placeholder: faint blocks where the chart and text go.
        ctx.fillStyle = colors.fg;
        ctx.globalAlpha = 0.12;
        const w = Math.max(0, band.width);
        ctx.fillRect(band.x, band.y + band.height * 0.35, w * 0.6, band.height * 0.65);
        if (w > 60) ctx.fillRect(band.x + w * 0.66, midY - 3, w * 0.34, 6);
        ctx.restore();
        return;
    }
    if (state.state === 'failed') {
        ctx.fillStyle = colors.fg;
        ctx.globalAlpha = 0.8;
        ctx.fillText('—', band.x, midY);
        ctx.restore();
        return;
    }
    const p = state.profile;
    const text = bandText(p);
    const textWidth = ctx.measureText(text).width;
    const { chart: rect, textX } = bandGeometry(band, textWidth);
    const chart = bandChart(p);
    if (rect) {
        if (chart.kind === 'histogram') {
            const max = Math.max(1, ...chart.bins.map(b => b.count));
            const lo = brush ? Math.min(brush[0], brush[1]) : -1;
            const hi = brush ? Math.max(brush[0], brush[1]) : -1;
            chart.bins.forEach((b, i) => {
                const slot = barSlot(rect, chart.bins.length, i);
                const h = b.count === 0 ? 0 : Math.max(1, Math.round((b.count / max) * rect.height));
                const inBrush = i >= lo && i <= hi;
                ctx.fillStyle = inBrush ? colors.accent : colors.fg;
                ctx.globalAlpha = inBrush ? 0.9 : 0.55;
                ctx.fillRect(slot.x, rect.y + rect.height - h, slot.width, h);
            });
        } else if (chart.kind === 'bars') {
            const area = chartArea(chart, rect);
            const max = Math.max(1, chart.values[0]?.count ?? 1);
            const n = chartSlots(chart);
            chart.values.forEach((e, i) => {
                const slot = barSlot(area, n, i);
                const h = Math.max(1, Math.round((e.count / max) * rect.height));
                ctx.fillStyle = colors.fg;
                ctx.globalAlpha = 0.55;
                ctx.fillRect(slot.x, rect.y + rect.height - h, slot.width, h);
            });
        } else if (chart.kind === 'logical') {
            const total = chart.t + chart.f + chart.na;
            if (total > 0) {
                const y = midY - 4;
                let x = rect.x;
                const parts: [number, string, number][] = [
                    [chart.t, colors.fg, 0.75],
                    [chart.f, colors.fg, 0.35],
                    [chart.na, colors.missing, 0.9],
                ];
                for (const [count, color, alpha] of parts) {
                    const w = (count / total) * rect.width;
                    if (w <= 0) continue;
                    ctx.fillStyle = color;
                    ctx.globalAlpha = alpha;
                    ctx.fillRect(x, y, Math.max(1, w), 8);
                    x += w;
                }
            }
        }
    }
    if (textX !== undefined) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = colors.fg;
        ctx.fillText(text, textX, midY);
    }
    ctx.restore();
}
