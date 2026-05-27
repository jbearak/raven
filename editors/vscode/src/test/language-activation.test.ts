import * as assert from 'assert';
import * as vscode from 'vscode';
import { meetsMinVersion } from '../version-gate';
import { activate } from './helper';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

// Companion to the static check in tests/bun/vscode-config.test.ts.
//
// The commit "drop redundant onLanguage activation events" removed the
// explicit onLanguage:{r,rmd,quarto,jags,stan} entries from the manifest.
// VS Code >= 1.74 auto-generates those activation events from
// contributes.languages, so the explicit ones were redundant (and the source
// of manifest warnings). This suite confirms — in a real VS Code instance —
// the precondition that makes them unnecessary: those languages are actually
// registered at runtime, on a VS Code new enough to auto-activate from
// contributions. We can't observe the auto-generated activation event firing
// (VS Code exposes no API for it, and the test harness force-activates the
// extension), so the registered-language set is the strongest available
// runtime signal.
suite('Raven language activation', () => {
    test('jags/stan/r are registered languages on VS Code >= 1.74', async () => {
        await activate();

        assert.ok(
            meetsMinVersion(vscode.version, 1, 74),
            `auto-activation from contributes.languages requires VS Code >= 1.74; ` +
                `running ${vscode.version}`,
        );

        const languages = await vscode.languages.getLanguages();
        for (const id of ['r', 'jags', 'stan']) {
            assert.ok(
                languages.includes(id),
                `expected '${id}' to be a registered language — ` +
                    `contributes.languages is what drives Raven's auto-activation`,
            );
        }
    });
});
