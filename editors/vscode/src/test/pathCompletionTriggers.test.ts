import * as assert from 'assert';
import {
    shouldTriggerDirectivePathSuggest,
    shouldTriggerNestedPathSuggest,
} from '../pathCompletionTriggers';

suite('Path Completion Triggers', () => {
    test('triggers after space form of forward directives', () => {
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-source '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '    # @lsp-run '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-include '),
            true,
        );
    });

    test('triggers after space form of backward directives', () => {
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-sourced-by '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-run-by '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-included-by '),
            true,
        );
    });

    test('triggers after colon form of forward directives', () => {
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-source: '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '    # @lsp-run: '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-include: '),
            true,
        );
    });

    test('triggers after colon form of backward directives', () => {
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-sourced-by: '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-run-by: '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-included-by: '),
            true,
        );
    });

    test('triggers for the canonical # raven: prefix (forward and backward)', () => {
        // #421: `# raven:` is the canonical alias of `@lsp-`; auto-trigger must
        // fire identically for both prefixes, otherwise raven: directives
        // silently lose the path-completion popup.
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# raven: source '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '    # raven: run-by '),
            true,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# raven: include: '),
            true,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('helpers/', '# raven: source helpers/'),
            true,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('shared/', '# raven: sourced-by "shared/'),
            true,
        );
    });

    test('does not trigger raven: suppression directives (not path-bearing)', () => {
        // `ignore`/`expect` are not in the path-bearing keyword set.
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# raven: ignore '),
            false,
        );
    });

    test('does not trigger for non-directive spaces or after path text', () => {
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# regular comment '),
            false,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest(' ', '# @lsp-source helpers.R '),
            false,
        );
        assert.strictEqual(
            shouldTriggerDirectivePathSuggest('/', '# @lsp-source '),
            false,
        );
    });

    test('triggers after selecting a directory completion in source calls', () => {
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('helpers/', 'source("helpers/'),
            true,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('models/', 'sys.source(file = "pkg/models/'),
            true,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('helpers/', 'source(local = TRUE, file = "helpers/'),
            true,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('models/', 'sys.source(envir = e, file = "pkg/models/'),
            true,
        );
    });

    test('triggers after selecting a directory completion in directives', () => {
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('helpers/', '# @lsp-source helpers/'),
            true,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('shared/', '# @lsp-sourced-by "shared/'),
            true,
        );
    });

    test('does not trigger nested navigation for single slash or file completions', () => {
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('/', 'source("helpers/'),
            false,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('helpers.R', 'source("helpers.R'),
            false,
        );
        assert.strictEqual(
            shouldTriggerNestedPathSuggest('helpers/', '# regular comment helpers/'),
            false,
        );
    });
});
