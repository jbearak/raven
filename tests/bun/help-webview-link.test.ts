// jsdom lives in editors/vscode/node_modules. Bun walks up from this test
// file looking for a node_modules dir, so we keep a tracked symlink at
// tests/bun/node_modules → ../../editors/vscode/node_modules to make it
// resolvable. (The repo has no root-level package.json.)
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

function assertReportError(post: ReturnType<typeof mock>): void {
    const call = post.mock.calls[0][0] as {
        type: string;
        payload: { message: string };
    };
    expect(call.type).toBe('report-error');
    expect(call.payload).toBeDefined();
    expect(typeof call.payload.message).toBe('string');
    expect(call.payload.message.length).toBeGreaterThan(0);
}

describe('webview link click', () => {
    // ---- raven-help:// → navigate ----

    test('raven-help://topic/base/sum → navigate, plain pkg/topic', () => {
        const a = makeAnchor('<a href="raven-help://topic/base/sum">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith({
            type: 'navigate',
            payload: { topic: 'sum', package: 'base', anchor: null },
        });
    });

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

    // ---- External URLs → defer to VS Code's webview default handling ----
    //
    // Returning false (no preventDefault, no postMessage) lets VS Code's
    // built-in webview link handler take over: it shows a single trust
    // prompt and opens the URL in the default browser. Posting our own
    // open-external would race with VS Code's handler and produce a
    // duplicate browser open + stray dialog.

    test('https:// → defers to VS Code (no preventDefault, no postMessage)', () => {
        const url = 'https://www.r-project.org/';
        const a = makeAnchor(`<a href="${url}">x</a>`);
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(false);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    test('http:// → defers to VS Code', () => {
        const url = 'http://example.com/docs';
        const a = makeAnchor(`<a href="${url}">x</a>`);
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(false);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    test('mailto: → defers to VS Code', () => {
        const url = 'mailto:someone@example.com';
        const a = makeAnchor(`<a href="${url}">x</a>`);
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(false);
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
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
        assertReportError(post);
    });

    test('file:// scheme → report-error', () => {
        const a = makeAnchor('<a href="file:///etc/shadow">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        assertReportError(post);
    });

    test('other:// scheme → report-error', () => {
        const a = makeAnchor('<a href="other://x">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        assertReportError(post);
    });

    test('relative ./foo path → report-error', () => {
        const a = makeAnchor('<a href="./foo/bar">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        assertReportError(post);
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
        assertReportError(post);
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
        assertReportError(post);
    });

    test('raven-help://topic/stats/ (empty topic) → report-error', () => {
        const a = makeAnchor('<a href="raven-help://topic/stats/">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        assertReportError(post);
    });

    test('raven-help://topic//foo (empty pkg) → report-error', () => {
        const a = makeAnchor('<a href="raven-help://topic//foo">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        assertReportError(post);
    });

    test('raven-help://topic/base/%ZZ (invalid percent) → report-error', () => {
        // Spec asks for a malformed URL that the URL parser/decoder rejects.
        // %ZZ is not valid percent-encoding; decodeURIComponent throws URIError.
        const a = makeAnchor('<a href="raven-help://topic/base/%ZZ">x</a>');
        const post = mock(() => {});
        const ev = makeEvent(a);
        const handled = classifyAndDispatch(ev, a.getAttribute('href'), false, post);
        expect(handled).toBe(true);
        expect(ev.preventDefault).toHaveBeenCalled();
        assertReportError(post);
    });
});
