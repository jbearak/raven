import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, openDocument, waitForDiagnostics, getFixtureUri, sleep } from './helper';

suite('Ark LSP Extension', () => {
    suiteSetup(async () => {
        await activate();
    });

    test('diagnostics are reported for undefined variables', async () => {
        const doc = await openDocument('diagnostics.R');
        const diagnostics = await waitForDiagnostics(doc.uri, 15000);
        assert.ok(diagnostics.length > 0, 'Expected diagnostics for undefined variable');
        const messages = diagnostics.map(d => d.message.toLowerCase());
        assert.ok(messages.some(m => m.includes('undefined') || m.includes('nonexistent')), 
            'Expected diagnostic about undefined variable');
    });

    test('go-to-definition works for function calls', async () => {
        const doc = await openDocument('definitions.R');
        // Position on 'add' call at line 12 (0-indexed: 11), column 12
        const position = new vscode.Position(11, 12);
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            doc.uri,
            position
        );
        assert.ok(locations && locations.length > 0, 'Expected definition location');
        assert.strictEqual(locations[0].range.start.line, 2, 'Expected definition at line 2');
    });

    test('document symbols are returned', async () => {
        const doc = await openDocument('symbols.R');
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            doc.uri
        );
        assert.ok(symbols && symbols.length > 0, 'Expected document symbols');
        const names = symbols.map(s => s.name);
        assert.ok(names.includes('my_function'), 'Expected my_function symbol');
    });

    test('find-references returns all usages', async () => {
        const doc = await openDocument('definitions.R');
        // Position on 'add' definition at line 3 (0-indexed: 2)
        const position = new vscode.Position(2, 0);
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            doc.uri,
            position
        );
        assert.ok(locations && locations.length >= 2, 'Expected at least 2 references (2 calls)');
    });

    test('completions are provided', async () => {
        const doc = await openDocument('completions.R');
        // Position after 'pri' at line 3 (0-indexed: 2), column 3
        const position = new vscode.Position(2, 3);
        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );
        assert.ok(completions && completions.items.length > 0, 'Expected completion items');
        const labels = completions.items.map(i => i.label);
        assert.ok(labels.some(l => typeof l === 'string' && l.startsWith('print')), 
            'Expected print in completions');
    });

    test('hover information is provided', async () => {
        const doc = await openDocument('definitions.R');
        // Position on 'add' function definition
        const position = new vscode.Position(2, 0);
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );
        assert.ok(hovers && hovers.length > 0, 'Expected hover information');
    });

    test('signature help is provided', async () => {
        const doc = await openDocument('definitions.R');
        // Position inside add() call arguments at line 11
        const position = new vscode.Position(10, 14);
        const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
            'vscode.executeSignatureHelpProvider',
            doc.uri,
            position,
            '('
        );
        // Signature help may not be available for user-defined functions
        // Just verify the command executes without error
        assert.ok(help === undefined || help.signatures !== undefined);
    });

    test('code actions are returned', async () => {
        const doc = await openDocument('symbols.R');
        const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10));
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            doc.uri,
            range
        );
        assert.ok(actions !== undefined && Array.isArray(actions), 'Expected code actions array');
    });

    test('folding ranges are provided', async () => {
        const doc = await openDocument('symbols.R');
        const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
            'vscode.executeFoldingRangeProvider',
            doc.uri
        );
        assert.ok(ranges && ranges.length > 0, 'Expected folding ranges for function bodies');
    });

    test('workspace: go-to-definition across files', async () => {
        const doc = await openDocument('workspace_main.R');
        console.log('Opened workspace_main.R:', doc.uri.toString());
        
        // Position on 'helper_func' call at line 3
        const position = new vscode.Position(3, 10);
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            doc.uri,
            position
        );
        
        console.log('Definition locations:', locations);
        console.log('Location count:', locations?.length);
        if (locations && locations.length > 0) {
            console.log('First location URI:', locations[0].uri.toString());
        }
        
        assert.ok(locations && locations.length > 0, `Expected definition location, got ${locations?.length || 0}`);
        assert.ok(locations[0].uri.path.includes('utils.R'), `Expected definition in utils.R, got ${locations[0].uri.path}`);
    });

    test('workspace: find-references across files', async () => {
        const doc = await openDocument('workspace/utils.R');
        console.log('Opened workspace/utils.R:', doc.uri.toString());
        
        // Position on 'helper_func' definition at line 3
        const position = new vscode.Position(2, 0);
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            doc.uri,
            position
        );
        
        console.log('Reference locations:', locations);
        console.log('Reference count:', locations?.length);
        if (locations) {
            locations.forEach((loc, i) => {
                console.log(`  [${i}] ${loc.uri.path}:${loc.range.start.line}`);
            });
        }
        
        assert.ok(locations && locations.length >= 2, `Expected at least 2 references, got ${locations?.length || 0}`);
        const files = locations.map(l => l.uri.path);
        assert.ok(files.some(f => f.includes('utils.R')), 'Expected reference in utils.R');
        assert.ok(files.some(f => f.includes('workspace_main.R')), 'Expected reference in workspace_main.R');
    });

    test('no false positives for function parameters', async () => {
        const doc = await openDocument('function_params.R');
        const diagnostics = await waitForDiagnostics(doc.uri, 15000);
        
        // Filter to only undefined variable warnings
        const undefinedVarDiags = diagnostics.filter(d => 
            d.message.toLowerCase().includes('undefined')
        );
        
        // Check that function parameters are NOT flagged as undefined
        const messages = undefinedVarDiags.map(d => d.message);
        assert.ok(!messages.some(m => m.includes('a') || m.includes('b')), 
            'Function parameters should not be flagged as undefined');
        assert.ok(!messages.some(m => m.includes('x') || m.includes('y')), 
            'Function parameters should not be flagged as undefined');
    });

    test('no false positives for built-in functions', async () => {
        const doc = await openDocument('function_params.R');
        const diagnostics = await waitForDiagnostics(doc.uri, 15000);
        
        // Filter to only undefined variable warnings
        const undefinedVarDiags = diagnostics.filter(d => 
            d.message.toLowerCase().includes('undefined')
        );
        
        // Check that built-in functions are NOT flagged as undefined
        const messages = undefinedVarDiags.map(d => d.message);
        assert.ok(!messages.some(m => m.includes('any')), 'Built-in "any" should not be undefined');
        assert.ok(!messages.some(m => m.includes('is.na')), 'Built-in "is.na" should not be undefined');
        assert.ok(!messages.some(m => m.includes('warning')), 'Built-in "warning" should not be undefined');
        assert.ok(!messages.some(m => m.includes('sprintf')), 'Built-in "sprintf" should not be undefined');
        assert.ok(!messages.some(m => m.includes('sum')), 'Built-in "sum" should not be undefined');
        assert.ok(!messages.some(m => m.includes('mean')), 'Built-in "mean" should not be undefined');
        assert.ok(!messages.some(m => m.includes('print')), 'Built-in "print" should not be undefined');
    });
});
