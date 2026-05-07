import type { SaveFormat } from '../messages';

export type PlotRenderOpts = {
    format: SaveFormat;
    width: number;
    height: number;
    bg: string | null;
};

export function plot_url(
    base: string,
    token: string,
    id: string,
    opts: PlotRenderOpts,
): string {
    const u = new URL(`${base}/plot`);
    u.searchParams.set('id', id);
    u.searchParams.set('renderer', opts.format);
    u.searchParams.set('width', String(opts.width));
    u.searchParams.set('height', String(opts.height));
    if (opts.bg !== null) u.searchParams.set('bg', opts.bg);
    u.searchParams.set('token', token);
    return u.toString();
}

export function plots_list_url(base: string, token: string): string {
    return `${base}/plots?token=${encodeURIComponent(token)}`;
}

export function ws_url(base: string, token: string): string {
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', token);
    // httpgd's WS endpoint is the server root.
    return u.toString();
}

export function remove_url(base: string, token: string, id: string): string {
    const u = new URL(`${base}/remove`);
    u.searchParams.set('id', id);
    u.searchParams.set('token', token);
    return u.toString();
}

// Live client used in the webview. Subscribes to httpgd's WebSocket and
// resolves a callback with the latest plot list when state changes.
export type HttpgdClient = {
    subscribe: (onChange: () => void) => void;
    fetchPlotIds: () => Promise<string[]>;
    remove: (id: string) => Promise<void>;
    close: () => void;
};

export function create_httpgd_client(base: string, token: string): HttpgdClient {
    let ws: WebSocket | null = null;
    let listener: (() => void) | null = null;

    return {
        subscribe(onChange) {
            if (ws) {
                ws.close();
                ws = null;
            }
            listener = onChange;
            ws = new WebSocket(ws_url(base, token));
            ws.addEventListener('message', () => listener?.());
            ws.addEventListener('open', () => listener?.());
            ws.addEventListener('close', () => { /* webview decides */ });
        },
        async fetchPlotIds() {
            const r = await fetch(plots_list_url(base, token));
            if (!r.ok) throw new Error(`httpgd /plots ${r.status}`);
            const body = await r.json() as { plots?: { id: string }[] };
            return (body.plots ?? []).map(p => p.id);
        },
        async remove(id: string) {
            const r = await fetch(remove_url(base, token, id));
            if (!r.ok) throw new Error(`httpgd /remove ${r.status}`);
        },
        close() {
            ws?.close();
            ws = null;
            listener = null;
        },
    };
}
