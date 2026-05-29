import * as vscode from 'vscode';
import { isPositron, isREditorSupportActive } from './r-console-activation';

/**
 * `.lintr` auto-enable gating for `raven.linting.enabled: "auto"`.
 *
 * A `.lintr` is REditorSupport's / `lintr`'s own config file. Under `"auto"`,
 * its mere presence historically flips Raven's native lints on. That is only
 * the right default when no other tool is already consuming the `.lintr`. This
 * module computes the client-only `linting.autoEnableFromDotLintr` signal the
 * server reads to suppress that auto-enable in environments where the `.lintr`
 * belongs to a live `lintr` path instead. See #337 and docs/linting.md.
 */

/**
 * True when REditorSupport's `lintr` diagnostics path is actually live: the
 * extension is installed+enabled AND both `r.lsp.enabled` and
 * `r.lsp.diagnostics` are on.
 *
 * REditorSupport defaults both `r.lsp.enabled` and `r.lsp.diagnostics` to
 * `true`, so an unset key counts as on. Arguments are injectable for testing;
 * the defaults read live VS Code state.
 */
export function reditorSupportLintPathActive(
    installed: boolean = isREditorSupportActive(),
    rConfig: Pick<vscode.WorkspaceConfiguration, 'get'> = vscode.workspace.getConfiguration('r'),
): boolean {
    if (!installed) {
        return false;
    }
    const lspEnabled = rConfig.get<boolean>('lsp.enabled', true);
    const lspDiagnostics = rConfig.get<boolean>('lsp.diagnostics', true);
    return lspEnabled !== false && lspDiagnostics !== false;
}

/**
 * Whether a discovered `.lintr` may auto-enable Raven's native linting under
 * `raven.linting.enabled: "auto"`.
 *
 * `false` when REditorSupport's `lintr` diagnostics path is live, or when
 * running inside Positron (which ships its own R-session linting) — contexts
 * where the `.lintr` is config for another tool, not a Raven opt-in. This
 * value is sent to the server as the client-only `linting.autoEnableFromDotLintr`
 * signal, which gates only the `.lintr` branch of `"auto"` resolution.
 */
export function dotLintrAutoEnableAllowed(
    reditorLintActive: boolean = reditorSupportLintPathActive(),
    positron: boolean = isPositron(),
): boolean {
    return !(reditorLintActive || positron);
}
