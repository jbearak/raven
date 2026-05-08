import { describe, test, expect, mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import { classifyAndDispatch } from '../../editors/vscode/src/help/webview/click-handler';

function makeAnchor(html: string): HTMLAnchorElement {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    return dom.window.document.querySelector('a')!;
}

function makeEvent(target: EventTarget | null): {
    target: EventTarget | null;
    preventDefault: ReturnType<typeof mock>;
} {
    return { target, preventDefault: mock(() => {}) };
}

describe('webview link click', () => {
    // ---- raven-help:// → navigate ----

    test('raven-help:// → navigate, percent-decoded ([)', () => {
        const a = makeAnchor('<a href="raven-help://topic/base/%5B">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith({
            type: 'navigate',
            payload: { topic: '[', package: 'base', anchor: null },
        });
    });

    test('raven-help:// → navigate, percent-decoded (+)', () => {
        const a = makeAnchor('<a href="raven-help://topic/base/%2B">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith({
            type: 'navigate',
            payload: { topic: '+', package: 'base', anchor: null },
        });
    });

    test('raven-help:// with anchor → navigate with anchor decoded', () => {
        const a = makeAnchor(
            '<a href="raven-help://topic/base/sum#examples">x</a>',
        );
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(post).toHaveBeenCalledWith({
            type: 'navigate',
            payload: { topic: 'sum', package: 'base', anchor: 'examples' },
        });
    });

    test('raven-help:// operator topic in another package → navigate', () => {
        const a = makeAnchor('<a href="raven-help://topic/dplyr/filter">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(post).toHaveBeenCalledWith({
            type: 'navigate',
            payload: { topic: 'filter', package: 'dplyr', anchor: null },
        });
    });

    // ---- External URLs → open-external ----

    test('https:// → open-external', () => {
        const url = 'https://www.r-project.org/';
        const a = makeAnchor(`<a href="${url}">x</a>`);
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith({
            type: 'open-external',
            payload: { url },
        });
    });

    test('http:// → open-external', () => {
        const url = 'http://example.com/docs';
        const a = makeAnchor(`<a href="${url}">x</a>`);
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith({
            type: 'open-external',
            payload: { url },
        });
    });

    test('mailto: → open-external', () => {
        const url = 'mailto:someone@example.com';
        const a = makeAnchor(`<a href="${url}">x</a>`);
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith({
            type: 'open-external',
            payload: { url },
        });
    });

    // ---- #anchor only → native scroll (no preventDefault, no postMessage) ----

    test('#anchor only → returns false, no preventDefault, no postMessage', () => {
        const a = makeAnchor('<a href="#section-1">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(false);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    // ---- Disallowed / malformed → report-error ----

    test('javascript: scheme → report-error', () => {
        const a = makeAnchor('<a href="javascript:alert(1)">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });

    test('file:// scheme → report-error', () => {
        const a = makeAnchor('<a href="file:///etc/shadow">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });

    test('other:// scheme → report-error', () => {
        const a = makeAnchor('<a href="other://x">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });

    test('relative ./foo path → report-error', () => {
        const a = makeAnchor('<a href="./foo/bar">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });

    test('data-raven-dropped anchor → report-error regardless of href', () => {
        const a = makeAnchor(
            '<a href="https://example.com" data-raven-dropped="1">x</a>',
        );
        const post = mock(() => {});
        const ev = makeEvent(a);
        // isDropped is true because data-raven-dropped="1"
        const isDropped = a.dataset['ravenDropped'] === '1';
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), isDropped, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });

    // ---- Malformed raven-help:// URLs → report-error ----

    test('raven-help://topic/ (empty pkg and topic) → report-error', () => {
        // URL.pathname will be "/" → parts = [""] → both empty
        const a = makeAnchor('<a href="raven-help://topic/">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });

    test('raven-help://topic/stats/ (empty topic) → report-error', () => {
        const a = makeAnchor('<a href="raven-help://topic/stats/">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });

    test('raven-help://topic//foo (empty pkg) → report-error', () => {
        const a = makeAnchor('<a href="raven-help://topic//foo">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        const call = (post as ReturnType<typeof mock>).mock.calls[0][0] as {
            type: string;
        };
        expect(call.type).toBe('report-error');
    });
});
