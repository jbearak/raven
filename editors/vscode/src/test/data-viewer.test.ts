/**
 * End-to-end smoke tests for the R data viewer. Requires:
 *   - R on PATH
 *   - The `arrow` R package installed
 *
 * Skipped automatically when R is not found in the system PATH or when
 * the `arrow` package is not installed.
 *
 * Tests run sequentially and share a single Raven R terminal created on
 * first call to `api.sendToRTerminal`. The terminal persists for the
 * suite duration — we do not dispose it to avoid interfering with the
 * extension's module-level state.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import type { RavenExtensionApi } from '../extension';
import { activate, sleep } from './helper';

async function pollForPanel(
    api: RavenExtensionApi,
    panelName: string,
    timeoutMs = 10000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (api.getDataViewerPanelNames().includes(panelName)) return true;
        await sleep(500);
    }
    return false;
}

/** Poll a predicate at 100 ms intervals until it returns a truthy value or
 *  the deadline elapses. Returns the truthy value on success or `undefined`
 *  on timeout (caller asserts). */
async function pollFor<T>(
    predicate: () => T | undefined,
    timeoutMs: number,
    intervalMs = 100,
): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) {
            return value as T;
        }
        await sleep(intervalMs);
    }
    return undefined;
}

suite('data-viewer smoke tests', function (this: Mocha.Suite) {
    // Each test may need to wait for R startup + arrow write + HTTP round-trip.
    this.timeout(120000);

    let api: RavenExtensionApi;

    suiteSetup(async function (this: Mocha.Context) {
        // Skip the whole suite if R is not reachable on the system PATH.
        const r_check = spawnSync('R', ['--version'], { timeout: 5000 });
        if (r_check.error) {
            this.skip();
            return;
        }

        // Skip if the `arrow` R package is not installed — without it the
        // bootstrap profile's View() override is a no-op.
        const arrow_check = spawnSync(
            'R', ['--vanilla', '-q', '--no-echo', '-e',
                'if (!requireNamespace("arrow", quietly=TRUE)) quit(status=1)'],
            { timeout: 10000 },
        );
        if (arrow_check.status !== 0) {
            this.skip();
            return;
        }

        await activate();
        const ext = vscode.extensions.getExtension<RavenExtensionApi>('jbearak.raven-r');
        if (!ext) { this.skip(); return; }
        if (!ext.isActive) await ext.activate();
        api = ext.exports as RavenExtensionApi;

        // Earlier suites (notably chunks.test.ts) stub `vscode.window.createTerminal`
        // to return a recording fake. The bundled extension caches the first
        // terminal it sees and never re-creates, and the fake is invisible to
        // `onDidCloseTerminal`, so without resetting here every `sendToRTerminal`
        // below would land in the dead stub and no panel would ever appear.
        api._disposeCachedRTerminalForTest();

        // Small wait for the async data-viewer setup (mkdir + stale sweep) that
        // runs after activate() returns.
        await sleep(500);
    });

    suiteTeardown(async function () {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('View(mtcars) opens a panel titled "mtcars" with the expected columns', async function () {
        await api.sendToRTerminal('View(mtcars)');

        const appeared = await pollForPanel(api, 'mtcars');
        assert.ok(appeared, 'data viewer panel "mtcars" did not appear');

        const cols = api.getDataViewerPanelColumnNames('mtcars');
        assert.ok(Array.isArray(cols), 'expected column names array for "mtcars" panel');

        // mtcars ships with R and always has these 11 columns in order.
        const expected = ['mpg', 'cyl', 'disp', 'hp', 'drat', 'wt', 'qsec', 'vs', 'am', 'gear', 'carb'];
        assert.deepStrictEqual(
            cols,
            expected,
            `unexpected columns; got: ${JSON.stringify(cols)}`,
        );
    });

    test('Arrow keys move the selected cell by one row or column', async function () {
        if (!api.getDataViewerPanelNames().includes('mtcars')) {
            await api.sendToRTerminal('View(mtcars)');
            const appeared = await pollForPanel(api, 'mtcars');
            assert.ok(appeared, 'data viewer panel "mtcars" did not appear');
        }

        await api.pressDataViewerKey('mtcars', 'Home');
        await api.pressDataViewerKey('mtcars', 'ArrowDown');
        const down = await pollFor(() => {
            const cell = api.getDataViewerPanelFocusCell('mtcars');
            return cell && cell.row === 1 && cell.col === 0 ? cell : undefined;
        }, 5000);
        assert.deepStrictEqual(down, { row: 1, col: 0 });

        await api.pressDataViewerKey('mtcars', 'ArrowRight');
        const right = await pollFor(() => {
            const cell = api.getDataViewerPanelFocusCell('mtcars');
            return cell && cell.row === 1 && cell.col === 1 ? cell : undefined;
        }, 5000);
        assert.deepStrictEqual(right, { row: 1, col: 1 });

        await api.pressDataViewerKey('mtcars', 'ArrowUp');
        const up = await pollFor(() => {
            const cell = api.getDataViewerPanelFocusCell('mtcars');
            return cell && cell.row === 0 && cell.col === 1 ? cell : undefined;
        }, 5000);
        assert.deepStrictEqual(up, { row: 0, col: 1 });

        await api.pressDataViewerKey('mtcars', 'ArrowLeft');
        const left = await pollFor(() => {
            const cell = api.getDataViewerPanelFocusCell('mtcars');
            return cell && cell.row === 0 && cell.col === 0 ? cell : undefined;
        }, 5000);
        assert.deepStrictEqual(left, { row: 0, col: 0 });
    });

    test('View(head(mtcars, 5)) opens a second panel without replacing "mtcars"', async function () {
        await api.sendToRTerminal('View(head(mtcars, 5))');

        const appeared = await pollForPanel(api, 'head(mtcars, 5)');
        assert.ok(appeared, 'data viewer panel "head(mtcars, 5)" did not appear within 60 s');

        const names = api.getDataViewerPanelNames();
        assert.ok(
            names.includes('mtcars'),
            `"mtcars" panel must still exist; panels: ${JSON.stringify(names)}`,
        );
        assert.ok(
            names.includes('head(mtcars, 5)'),
            `"head(mtcars, 5)" panel must exist; panels: ${JSON.stringify(names)}`,
        );
    });

    test('View(mtcars) a second time replaces the existing tab rather than opening a new one', async function () {
        const before = api.getDataViewerPanelNames().slice();

        await api.sendToRTerminal('View(mtcars)');

        // Poll until the panel count stops changing, then assert it equals the
        // count from before the command (replace, not create).
        //
        // Since the "mtcars" panel already exists, a correct implementation
        // replaces in-place and no new entry is added to the manager's map.
        // We give up to 45 s for R to write the Arrow file and POST.
        const deadline = Date.now() + 45000;
        let stable = 0;
        let last = api.getDataViewerPanelNames().length;
        while (Date.now() < deadline) {
            await sleep(1000);
            const current = api.getDataViewerPanelNames().length;
            if (current === last) {
                stable += 1;
                if (stable >= 3) break; // 3 consecutive stable seconds
            } else {
                stable = 0;
                last = current;
            }
        }

        const after = api.getDataViewerPanelNames();
        assert.strictEqual(
            after.length,
            before.length,
            `expected ${before.length} panels after replace; got ${after.length}: ${JSON.stringify(after)}`,
        );
        assert.ok(
            after.includes('mtcars'),
            `"mtcars" panel must still be open after replace; panels: ${JSON.stringify(after)}`,
        );
    });

    test('End key reaches the last row in a 700K-row data frame', async function () {
        // R startup + 700K rnorm + arrow write + scroll round-trip can run
        // up against the suite's 120 s default when earlier suites have put
        // the runner under load. Give this test its own larger budget so
        // it isn't flaky on slow CI runners.
        this.timeout(240000);

        // Smallest size that engages the cap (700_000 × 24 = 16.8 M >
        // MAX_SCROLL_PX of 15 M) — exactly the failure mode from #183.
        const N = 700_000;

        await api.sendToRTerminal(
            `big <- as.data.frame(matrix(rnorm(${N} * 5), `
            + `nrow = ${N}, ncol = 5)); View(big)`,
        );

        // Wait for the panel to exist. R startup + matrix rnorm + Arrow
        // write can take several seconds on a cold runner; allow extra
        // headroom for slow CI.
        const panelAppeared = await pollForPanel(api, 'big', 90000);
        assert.ok(panelAppeared, 'panel "big" did not appear within 90 s');

        // Reset scroll to the top before the End test. A previous --watch
        // run could have left the same-shape panel scrolled to the bottom;
        // applyInitOrReplace's sameDataset branch intentionally preserves
        // visibleRangeStart, so an unconditional 'end < N/2' gate would
        // deadlock on that. Pressing Home first makes the readiness gate
        // robust regardless of prior state.
        //
        // Note: this is NOT a positive test for Home — a fresh panel's
        // initial fetch lands at the top regardless of whether Home does
        // anything, so the gate below is satisfied either way. It's
        // strictly a deterministic-reset step for the End test.
        await api.pressDataViewerKey('big', 'Home');

        // Wait for the Home reset to land AND rows for the top of the
        // grid to be fetched. A mount/init lifecycle reports
        // {start: 0, end: 0}, which would satisfy 'end < N/2' alone — so
        // require end > 0 too.
        const topRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            return r && r.end > 0 && r.end < N / 2 ? r : undefined;
        }, 60000);
        assert.ok(topRange,
            `Home reset did not land at the top within 60 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);

        // Drive End and wait for the bottom-row fetch to land.
        await api.pressDataViewerKey('big', 'End');

        const bottomRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            return r && r.end === N ? r : undefined;
        }, 60000);
        assert.ok(bottomRange,
            `End key did not reach the last row within 60 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);
    });

    test('Drag scrollbar to bottom reaches last row in 700K-row data frame', async function () {
        // R startup + 700K rnorm + arrow write + scroll round-trip can
        // run up against the suite's 120 s default when earlier suites
        // have put the runner under load.
        this.timeout(240000);
        const N = 700_000;

        // Reuse the panel from the End-key test if still open;
        // otherwise the prior test created and left it in place.
        if (!api.getDataViewerPanelNames().includes('big')) {
            await api.sendToRTerminal(
                `big <- as.data.frame(matrix(rnorm(${N} * 5), `
                + `nrow = ${N}, ncol = 5)); View(big)`,
            );
            const appeared = await pollForPanel(api, 'big', 90000);
            assert.ok(appeared, 'panel "big" did not appear within 90 s');
        }

        // Reset to top, wait for steady state.
        await api.pressDataViewerKey('big', 'Home');
        const topRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            return r && r.end > 0 && r.end < N / 2 ? r : undefined;
        }, 60000);
        assert.ok(topRange,
            `pre-drag Home reset did not land at the top within 60 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);

        // Drag the scrollbar thumb to the bottom.
        await api.dragDataViewerScrollbar('big', 1.0);

        const bottomRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            return r && r.end === N ? r : undefined;
        }, 60000);
        assert.ok(bottomRange,
            `Drag-to-bottom did not reach the last row within 60 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);
    });

    test('Drag scrollbar to bottom reaches last row in 10M-row data frame', async function () {
        // This is the real large-table regression: webview scrollbar
        // clamping can be lower than the model's nominal capped height,
        // so the custom scrollbar must map the measured physical bottom
        // to the logical last row.
        this.timeout(360000);
        const N = 10_000_000;
        const panelName = `huge_scroll_${Date.now()}`;

        await api.sendToRTerminal(
            `${panelName} <- data.frame(col1 = seq_len(${N})); View(${panelName})`,
        );
        const appeared = await pollForPanel(api, panelName, 180000);
        assert.ok(appeared, `panel "${panelName}" did not appear within 180 s`);

        await api.pressDataViewerKey(panelName, 'Home');
        const topRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange(panelName);
            return r && r.end > 0 && r.end < N / 2 ? r : undefined;
        }, 60000);
        assert.ok(topRange,
            `pre-drag Home reset did not land at the top within 60 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange(panelName))}`);

        await api.dragDataViewerScrollbar(panelName, 1.0);

        const bottomRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange(panelName);
            return r && r.end === N ? r : undefined;
        }, 60000);
        assert.ok(bottomRange,
            `10M-row drag-to-bottom did not reach the last row within 60 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange(panelName))}`);

        const viewportRange = await pollFor(() => {
            const r = api.getDataViewerPanelViewportRange(panelName);
            return r && r.end === N ? r : undefined;
        }, 60000);
        assert.ok(viewportRange,
            `10M-row drag-to-bottom fetched the last row but did not render it on screen; `
            + `last viewport range: ${JSON.stringify(api.getDataViewerPanelViewportRange(panelName))}; `
            + `last fetched range: ${JSON.stringify(api.getDataViewerPanelVisibleRange(panelName))}`);
    });

    test('Drag scrollbar to 50% lands near row N/2 in 700K-row data frame', async function () {
        this.timeout(240000);
        const N = 700_000;

        if (!api.getDataViewerPanelNames().includes('big')) {
            await api.sendToRTerminal(
                `big <- as.data.frame(matrix(rnorm(${N} * 5), `
                + `nrow = ${N}, ncol = 5)); View(big)`,
            );
            const appeared = await pollForPanel(api, 'big', 90000);
            assert.ok(appeared, 'panel "big" did not appear within 90 s');
        }

        await api.pressDataViewerKey('big', 'Home');
        const topRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            return r && r.end > 0 && r.end < N / 2 ? r : undefined;
        }, 60000);
        assert.ok(topRange);

        await api.dragDataViewerScrollbar('big', 0.5);

        const midRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            if (!r) return undefined;
            // Allow a generous 10 % band around N/2 — the exact value
            // depends on thumb-height / track-usable arithmetic.
            return r.start >= 0.40 * N && r.start <= 0.60 * N ? r : undefined;
        }, 60000);
        assert.ok(midRange,
            `Drag-to-50% did not land near N/2 within 60 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);
    });
});
