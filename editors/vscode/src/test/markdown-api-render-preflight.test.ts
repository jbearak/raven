import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate } from './helper';

/**
 * Pre-flight verification of `markdown.api.render`.
 *
 * Before committing to the hybrid architecture for the Knit Output
 * syntax-highlighting feature, we want concrete evidence of what
 * `vscode.commands.executeCommand('markdown.api.render', source)`
 * returns for:
 *
 *  - inline math (`$x = y$`)
 *  - display math (`$$x = y$$`)
 *  - fenced R code block
 *  - fenced Python code block
 *  - fenced block with no language tag
 *  - raw HTML pass-through (mimicking an htmlwidget)
 *  - image reference (relative path)
 *
 * The assertions are lenient — they confirm the command exists, returns
 * a string, and inlines the marker text. The real value is the dumped
 * HTML, which the test logs so we can read the shape of each block
 * type and plan the post-processing pipeline.
 *
 * This test is intentionally not a regression test of the design — it
 * is a one-shot probe. Once the architecture is locked in we can drop
 * or rewrite this file.
 */
suite('markdown.api.render pre-flight', () => {
    test('renders math, code blocks, raw HTML, and images', async function () {
        this.timeout(30000);
        await activate();

        // Force-activate VS Code's built-in markdown features so the
        // `markdown.api.render` command is registered. The vscode-test
        // harness disables auto-activation for many built-ins.
        const mdExt = vscode.extensions.getExtension('vscode.markdown-language-features');
        console.log('markdown extension state:', JSON.stringify({
            present: !!mdExt,
            isActive: mdExt?.isActive,
        }));
        if (mdExt && !mdExt.isActive) {
            try {
                await mdExt.activate();
            } catch (e) {
                console.log('failed to activate markdown extension:', String(e));
            }
        }

        const mathExt = vscode.extensions.getExtension('vscode.markdown-math');
        console.log('markdown-math extension state:', JSON.stringify({
            present: !!mathExt,
            isActive: mathExt?.isActive,
        }));
        if (mathExt && !mathExt.isActive) {
            try {
                await mathExt.activate();
            } catch (e) {
                console.log('failed to activate markdown-math extension:', String(e));
            }
        }

        const commands = await vscode.commands.getCommands(true);
        const renderAvailable = commands.includes('markdown.api.render');
        console.log('markdown.api.render available:', renderAvailable);
        if (!renderAvailable) {
            const mdCommands = commands.filter(c => c.startsWith('markdown.'));
            console.log('available markdown.* commands:', mdCommands.length);
            console.log(mdCommands.join('\n'));
        }
        assert.ok(
            renderAvailable,
            'markdown.api.render command should be available in the running VS Code',
        );

        const source = [
            '# Preflight',
            '',
            'Inline math: $E = mc^2$ in the middle of a sentence.',
            '',
            'Display math:',
            '',
            '$$',
            '\\sum_{i=1}^{n} x_i',
            '$$',
            '',
            'A fenced R code block:',
            '',
            '```r',
            'library(ggplot2)',
            'f <- function(x) x + 1',
            'mtcars |> head()',
            '```',
            '',
            'A fenced Python code block:',
            '',
            '```python',
            'import math',
            'print(math.sqrt(2))',
            '```',
            '',
            'A fenced block with no language tag:',
            '',
            '```',
            'plain text, no language',
            '```',
            '',
            'A raw HTML pass-through (mimicking an htmlwidget):',
            '',
            '<div class="htmlwidget-fake" id="widget-123" style="width:100%">',
            '  <p>Widget content</p>',
            '</div>',
            '',
            'An image:',
            '',
            '![alt-text](figure-html/plot-1.png)',
            '',
            'PREFLIGHT-MARKER-9X4ZQ',
            '',
        ].join('\n');

        const html = await vscode.commands.executeCommand<string>(
            'markdown.api.render',
            source,
        );

        assert.ok(typeof html === 'string', 'render result should be a string');
        assert.ok(html.length > 0, 'render result should not be empty');
        assert.ok(
            html.includes('PREFLIGHT-MARKER-9X4ZQ'),
            'render result should contain our marker',
        );

        // Dump the full HTML to the test channel so a human can read
        // the shape of code blocks, math, raw HTML, and images.
        console.log('=== markdown.api.render output (begin) ===');
        console.log(html);
        console.log('=== markdown.api.render output (end) ===');

        // Soft probes — log what we find, don't fail. These tell us
        // whether VS Code's pipeline already runs the relevant plugin
        // server-side or defers rendering to client-side scripts.
        const hasKatexClass = /class="[^"]*\bkatex\b/i.test(html);
        const hasInlineMathDelim = html.includes('$E = mc^2$');
        const hasDisplayMathDelim = html.includes('\\sum_{i=1}^{n} x_i');
        const hasFencedR = /<code[^>]*class="[^"]*language-r/i.test(html)
            || /<code[^>]*class="[^"]*\br\b/.test(html);
        const hasFencedPython = /<code[^>]*class="[^"]*language-python/i.test(html)
            || /<code[^>]*class="[^"]*\bpython\b/.test(html);
        const hasRawWidget = html.includes('htmlwidget-fake');
        const hasImage = /<img\b[^>]*src="[^"]*figure-html\/plot-1\.png"/i.test(html);
        const hasHighlightSpans = /<span[^>]*class="[^"]*(?:hljs|token|tok-)/.test(html);

        console.log('preflight probes:', JSON.stringify({
            hasKatexClass,
            hasInlineMathDelim,
            hasDisplayMathDelim,
            hasFencedR,
            hasFencedPython,
            hasRawWidget,
            hasImage,
            hasHighlightSpans,
        }, null, 2));
    });
});
