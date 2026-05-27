/**
 * Editor-tab icons for Raven's webview viewers (help, data, plot, knit).
 *
 * `WebviewPanel.iconPath` only began honoring a `ThemeIcon` (codicon) at
 * runtime in **VSCode 1.110** (microsoft/vscode#282608, finalized Feb 2026).
 * Raven targets `engines.vscode: ^1.82.0`, and on older hosts the *only* way
 * to set a custom tab icon is an image-file `Uri` — which we deliberately do
 * not ship. So the icon is gated on the running VSCode version: on 1.110+ the
 * panel gets its codicon; on older hosts `iconPath` is left unset and the tab
 * keeps VSCode's default page icon (a graceful no-op, never an error).
 *
 * This is the single source of truth for that gate. New viewers should call
 * `viewerTabIcon(...)` rather than constructing a `ThemeIcon` directly, so the
 * version guard stays in one place.
 */

import * as vscode from 'vscode';
import { meetsMinVersion } from './version-gate';

/** First VSCode version whose runtime renders a `ThemeIcon` as a webview tab icon. */
const THEME_ICON_TAB_MIN = { major: 1, minor: 110 } as const;

/**
 * A codicon to assign to a webview panel's `iconPath`, or `undefined` on
 * hosts that predate `ThemeIcon` tab-icon support. Assigning `undefined` to
 * `iconPath` is valid and leaves the default page icon in place.
 */
export function viewerTabIcon(codiconId: string): vscode.ThemeIcon | undefined {
    // `vscode.version` is always a string at runtime; guard anyway so test
    // doubles that omit it fall through to "unsupported" rather than throwing.
    if (typeof vscode.version !== 'string') return undefined;
    return meetsMinVersion(vscode.version, THEME_ICON_TAB_MIN.major, THEME_ICON_TAB_MIN.minor)
        ? new vscode.ThemeIcon(codiconId)
        : undefined;
}
