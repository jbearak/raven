export interface PlainRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
}

export interface LayoutSnapshot {
    type: 'test:layoutSnapshot';
    seq: number;
    isWrapped: boolean;
    toolbarRect: PlainRect;
    chipsRect: PlainRect;
    actionsRect: PlainRect;
    leadRect: PlainRect;
    rootRect: PlainRect;
    /** Intrinsic widths the hook itself uses — see `intrinsicWidthPx`
     *  in use-toolbar-wrap.ts. Calibration tests rely on these. */
    leadIntrinsicWidth: number;
    chipsIntrinsicWidth: number;
    actionsIntrinsicWidth: number;
    chipsScrollWidth: number;
    chipsClientWidth: number;
    sortStripScrollWidth: number;
    sortStripClientWidth: number;
    filterStripScrollWidth: number;
    toolbarFlexWrap: string;
    chipsOrder: string;
    chipsFlexBasis: string;
    widthPx: number | null;
    sortChipCount: number;
    filterChipCount: number;
    hiddenColCount: number;
    rowCountText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Tell whether a layout snapshot reflects the control message just sent by
 * the extension-host test. React state updates in the webview are async, so
 * a synchronous `test:requestSnapshot` can legitimately report the previous
 * render. The host must ignore those stale-but-well-formed snapshots.
 */
export function snapshotReflectsMessage(message: unknown, snap: LayoutSnapshot): boolean {
    if (!isRecord(message) || typeof message.type !== 'string') return true;

    switch (message.type) {
        case 'test:reset':
            return snap.widthPx === null
                && snap.sortChipCount === 0
                && snap.filterChipCount === 0
                && snap.hiddenColCount === 0
                && snap.rowCountText === '';

        case 'test:setWidth':
            return typeof message.widthPx === 'number'
                && snap.widthPx === message.widthPx;

        case 'test:setState':
            return typeof message.sortChipCount === 'number'
                && typeof message.filterChipCount === 'number'
                && typeof message.hiddenColCount === 'number'
                && typeof message.rowCountText === 'string'
                && snap.sortChipCount === message.sortChipCount
                && snap.filterChipCount === message.filterChipCount
                && snap.hiddenColCount === message.hiddenColCount
                && snap.rowCountText === message.rowCountText;

        default:
            return true;
    }
}
