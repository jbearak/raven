import { describe, test, expect } from 'bun:test';
import {
    rewriteImageSrcs,
    type RewriteContext,
} from '../../editors/vscode/src/help/image-rewriter';
import * as path from 'path';

function ctx(helpDir: string): RewriteContext {
    return {
        helpDir,
        libPaths: [path.dirname(path.dirname(helpDir))],
        asWebviewUri: (abs: string) => `webview-uri:${abs}`,
        fileExists: () => true,
    };
}

describe('image-rewriter', () => {
    test('relative src under helpDir is rewritten', () => {
        const c = ctx('/lib/dplyr/help');
        const html = `<img src="figures/x.png">`;
        const out = rewriteImageSrcs(html, c);
        expect(out).toContain('webview-uri:/lib/dplyr/help/figures/x.png');
    });

    test('data: src passes through', () => {
        const c = ctx('/lib/dplyr/help');
        const html = `<img src="data:image/png;base64,AAAA">`;
        const out = rewriteImageSrcs(html, c);
        expect(out).toContain('data:image/png;base64,AAAA');
    });

    test('http and https are dropped', () => {
        const c = ctx('/lib/dplyr/help');
        const out1 = rewriteImageSrcs(`<img src="http://evil/x">`, c);
        const out2 = rewriteImageSrcs(`<img src="https://evil/x">`, c);
        expect(out1).toContain('src=""');
        expect(out2).toContain('src=""');
    });

    test('path traversal outside helpDir is dropped', () => {
        const c = ctx('/lib/dplyr/help');
        const out = rewriteImageSrcs(`<img src="../../../../etc/passwd">`, c);
        expect(out).toContain('src=""');
    });

    test('cross-package reference is dropped', () => {
        const c = ctx('/lib/dplyr/help');
        const out = rewriteImageSrcs(
            `<img src="../../OTHERPKG/help/figures/x.png">`,
            c,
        );
        expect(out).toContain('src=""');
    });

    test('file: scheme is dropped', () => {
        const c = ctx('/lib/dplyr/help');
        const out = rewriteImageSrcs(`<img src="file:///etc/passwd">`, c);
        expect(out).toContain('src=""');
    });

    test('relative src for a missing file is dropped', () => {
        const c: RewriteContext = {
            helpDir: '/lib/dplyr/help',
            libPaths: ['/lib'],
            asWebviewUri: (abs) => `webview-uri:${abs}`,
            fileExists: (abs) => abs !== '/lib/dplyr/help/figures/missing.png',
        };
        const out = rewriteImageSrcs(`<img src="figures/missing.png">`, c);
        expect(out).toContain('src=""');
    });
});
