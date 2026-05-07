import { describe, test, expect } from 'bun:test';
import { plot_url, plots_list_url, ws_url, remove_url } from '../../editors/vscode/src/plot/webview/httpgd-client';

describe('httpgd-client URL builders', () => {
    const base = 'http://127.0.0.1:7777';
    const token = 'plot-tok';

    test('plot_url includes id, format, dimensions, bg, and token', () => {
        const u = plot_url(base, token, 'p1', { format: 'svg', width: 640, height: 480, bg: '#1e1e1e' });
        expect(u).toContain(`${base}/plot`);
        expect(u).toContain('id=p1');
        expect(u).toContain('width=640');
        expect(u).toContain('height=480');
        expect(u).toContain('renderer=svg');
        expect(u).toContain('bg=%231e1e1e');
        expect(u).toContain('token=plot-tok');
    });

    test('plot_url omits bg when null', () => {
        const u = plot_url(base, token, 'p1', { format: 'png', width: 100, height: 100, bg: null });
        expect(u).not.toContain('bg=');
    });

    test('plots_list_url includes token', () => {
        const u = plots_list_url(base, token);
        expect(u).toBe(`${base}/plots?token=${token}`);
    });

    test('ws_url converts http→ws and includes token', () => {
        expect(ws_url(base, token)).toBe(`ws://127.0.0.1:7777/?token=${token}`);
    });

    test('ws_url converts https→wss', () => {
        expect(ws_url('https://example.com:8443', token)).toBe(`wss://example.com:8443/?token=${token}`);
    });

    test('remove_url includes id and token', () => {
        const u = remove_url(base, token, 'p1');
        expect(u).toContain('/remove');
        expect(u).toContain('id=p1');
        expect(u).toContain('token=plot-tok');
    });
});
