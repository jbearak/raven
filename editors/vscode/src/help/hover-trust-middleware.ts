import * as vscode from 'vscode';

type Provider = (
    doc: vscode.TextDocument,
    pos: vscode.Position,
    tok: vscode.CancellationToken,
) => Promise<vscode.Hover | null | undefined>;

/**
 * Wraps a hover provider so that any returned MarkdownString carries
 * narrow command-link trust for `raven.openHelpPanel` only.
 *
 * VS Code blocks `command:` links in hover markdown unless the
 * MarkdownString.isTrusted flag is set. Setting `isTrusted: true` would
 * trust ALL commands, which is dangerous; the safer narrow form
 * `{ enabledCommands: [...] }` only allows the listed commands.
 *
 * This middleware should be installed in the LSP client's hover provider
 * chain so server-emitted hover markdown can carry command-link triggers
 * (notably the bold "open help panel" heading prepended by the server).
 */
export function wrapHoverWithHelpTrust(next: Provider): Provider {
    return async (doc, pos, tok) => {
        const hover = await next(doc, pos, tok);
        if (!hover) return hover;
        for (const c of hover.contents) {
            if (c instanceof vscode.MarkdownString) {
                c.isTrusted = { enabledCommands: ['raven.openHelpPanel'] };
            }
        }
        return hover;
    };
}
