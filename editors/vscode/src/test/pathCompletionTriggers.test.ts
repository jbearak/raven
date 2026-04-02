import * as assert from 'assert';
import { shouldTriggerDirectivePathSuggest } from '../pathCompletionTriggers';

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
});
