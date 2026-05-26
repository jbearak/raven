/**
 * FilterHistogram — inline SVG histogram with two draggable range thumbs.
 *
 * Renders uniform-width bins as vertical bars whose height is proportional to
 * the bin count (normalized to the max count). Two thumb handles sit on top
 * of the axis at the lo/hi positions; dragging (or keyboard nudging) calls
 * onChange.
 *
 * Invariants:
 *  - lo ≤ hi at all times; swapping is clamped silently.
 *  - The value domain is [bins[0].lo, bins[bins.length-1].hi].
 *  - Keyboard: Arrow nudges by one bin width; Shift+Arrow by 10×.
 *  - Each thumb exposes role="slider" / aria-valuemin/max/now.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { HistogramBin } from '../messages';

type Props = {
    bins: HistogramBin[];
    lo: number;
    hi: number;
    onChange: (lo: number, hi: number) => void;
};

const SVG_W = 260;
const SVG_H = 52;
const AXIS_Y = SVG_H - 12;
const BAR_BOTTOM = AXIS_Y - 2;
const THUMB_R = 6;
const MARGIN_X = THUMB_R + 2;

function domainMin(bins: HistogramBin[]): number {
    return bins[0].lo;
}
function domainMax(bins: HistogramBin[]): number {
    return bins[bins.length - 1].hi;
}

function valueToX(value: number, dMin: number, dMax: number): number {
    if (dMax === dMin) return MARGIN_X + (SVG_W - 2 * MARGIN_X) / 2;
    return MARGIN_X + ((value - dMin) / (dMax - dMin)) * (SVG_W - 2 * MARGIN_X);
}

function xToValue(x: number, dMin: number, dMax: number): number {
    const frac = (x - MARGIN_X) / (SVG_W - 2 * MARGIN_X);
    return dMin + Math.max(0, Math.min(1, frac)) * (dMax - dMin);
}

function snapToBin(value: number, bins: HistogramBin[]): number {
    // Snap to nearest bin edge
    let best = bins[0].lo;
    let bestDist = Math.abs(value - best);
    for (const bin of bins) {
        for (const edge of [bin.lo, bin.hi]) {
            const d = Math.abs(value - edge);
            if (d < bestDist) { bestDist = d; best = edge; }
        }
    }
    return best;
}

export function FilterHistogram({ bins, lo, hi, onChange }: Props) {
    if (bins.length === 0) return null;
    const svgRef = useRef<SVGSVGElement>(null);
    const dragging = useRef<'lo' | 'hi' | null>(null);

    const dMin = domainMin(bins);
    const dMax = domainMax(bins);
    const maxCount = Math.max(...bins.map(b => b.count), 1);

    const binWidth = bins.length > 0 ? (SVG_W - 2 * MARGIN_X) / bins.length : 0;

    const loX = valueToX(lo, dMin, dMax);
    const hiX = valueToX(hi, dMin, dMax);

    const getSvgX = useCallback((clientX: number): number => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return MARGIN_X;
        return ((clientX - rect.left) / rect.width) * SVG_W;
    }, []);

    // Drag reads live lo/hi/bins/onChange from a ref so the window listeners
    // can be STABLE (registered once, identity never changes). Without this,
    // each onChange re-renders the component, changing a useCallback-based
    // handler's identity mid-drag — which both leaks the originally-added
    // listener and can leave a dangling pointermove handler if the popover
    // unmounts before pointerup fires. The unmount effect below is the
    // backstop for the close-mid-drag case.
    const live = useRef({ bins, dMin, dMax, lo, hi, onChange, getSvgX });
    live.current = { bins, dMin, dMax, lo, hi, onChange, getSvgX };

    const handlersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);
    if (handlersRef.current === null) {
        const move = (e: PointerEvent) => {
            if (!dragging.current) return;
            const s = live.current;
            const rawValue = xToValue(s.getSvgX(e.clientX), s.dMin, s.dMax);
            const snapped = snapToBin(rawValue, s.bins);
            if (dragging.current === 'lo') s.onChange(Math.min(snapped, s.hi), s.hi);
            else s.onChange(s.lo, Math.max(snapped, s.lo));
        };
        const up = () => {
            dragging.current = null;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        handlersRef.current = { move, up };
    }

    useEffect(() => () => {
        const h = handlersRef.current;
        if (!h) return;
        window.removeEventListener('pointermove', h.move);
        window.removeEventListener('pointerup', h.up);
    }, []);

    const startDrag = useCallback((which: 'lo' | 'hi') => (e: React.PointerEvent) => {
        e.preventDefault();
        dragging.current = which;
        const h = handlersRef.current!;
        window.addEventListener('pointermove', h.move);
        window.addEventListener('pointerup', h.up);
    }, []);

    const binStep = bins.length > 1 ? bins[1].lo - bins[0].lo : dMax - dMin;

    const onKeyDown = (which: 'lo' | 'hi') => (e: React.KeyboardEvent) => {
        const step = e.shiftKey ? binStep * 10 : binStep;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            if (which === 'lo') onChange(Math.max(dMin, lo - step), hi);
            else onChange(lo, Math.max(lo, hi - step));
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (which === 'lo') onChange(Math.min(hi, lo + step), hi);
            else onChange(lo, Math.min(dMax, hi + step));
        }
    };

    // Selected range overlay
    const selX = Math.min(loX, hiX);
    const selW = Math.abs(hiX - loX);

    return (
        <svg
            ref={svgRef}
            className="filter-histogram"
            width={SVG_W}
            height={SVG_H}
            // viewBox makes the fixed 260-unit layout scale to the popover's
            // actual content width (≈236px at the min popover width), so the
            // right thumb at the domain max stays inside the box instead of
            // being clipped. getSvgX maps via the rendered rect, so the drag
            // math is unaffected by the scale.
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label="Range histogram"
            style={{ display: 'block', width: '100%', maxWidth: `${SVG_W}px`, height: `${SVG_H}px`, cursor: 'default', userSelect: 'none' }}
        >
            {/* Bars */}
            {bins.map((bin, i) => {
                const barH = Math.round(((BAR_BOTTOM - 4) * bin.count) / maxCount);
                const x = MARGIN_X + i * binWidth;
                const inRange = bin.lo >= lo && bin.hi <= hi;
                return (
                    <rect
                        key={i}
                        x={x + 0.5}
                        y={BAR_BOTTOM - barH}
                        width={Math.max(1, binWidth - 1)}
                        height={barH}
                        className={inRange ? 'filter-histogram-bar in-range' : 'filter-histogram-bar'}
                    />
                );
            })}
            {/* Axis line */}
            <line
                x1={MARGIN_X}
                y1={AXIS_Y}
                x2={SVG_W - MARGIN_X}
                y2={AXIS_Y}
                className="filter-histogram-axis"
            />
            {/* Selected range highlight on axis */}
            <rect
                x={selX}
                y={AXIS_Y - 2}
                width={selW}
                height={4}
                className="filter-histogram-range"
            />
            {/* Lo thumb */}
            <circle
                cx={loX}
                cy={AXIS_Y}
                r={THUMB_R}
                className="filter-histogram-thumb"
                tabIndex={0}
                role="slider"
                aria-label="Low value"
                aria-valuemin={dMin}
                aria-valuemax={dMax}
                aria-valuenow={lo}
                onPointerDown={startDrag('lo')}
                onKeyDown={onKeyDown('lo')}
                style={{ cursor: 'ew-resize', outline: 'none' }}
            />
            {/* Hi thumb */}
            <circle
                cx={hiX}
                cy={AXIS_Y}
                r={THUMB_R}
                className="filter-histogram-thumb"
                tabIndex={0}
                role="slider"
                aria-label="High value"
                aria-valuemin={dMin}
                aria-valuemax={dMax}
                aria-valuenow={hi}
                onPointerDown={startDrag('hi')}
                onKeyDown={onKeyDown('hi')}
                style={{ cursor: 'ew-resize', outline: 'none' }}
            />
        </svg>
    );
}

/** Small helper: given the current lo/hi and histogram bins, return the
 *  subset of bins fully within [lo, hi] for external use. Not used by the
 *  component itself but exported for callers that want counts. */
export function binsInRange(bins: HistogramBin[], lo: number, hi: number): HistogramBin[] {
    return bins.filter(b => b.lo >= lo && b.hi <= hi);
}
