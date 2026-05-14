import * as vscode from 'vscode';
import {
    classify_chunk_document_for_document,
    detect_chunks,
    has_chunk_anchor,
    is_runnable_chunk,
} from './chunk-detector';
import { CHUNK_LENS_COMMANDS } from './chunk-commands';

/** Configuration key for the user-configurable CodeLens command list. */
const CODELENS_COMMANDS_SETTING = 'raven.chunks.codeLens.commands';

/**
 * Default CodeLens menu — matches the pre-configuration behavior so existing
 * users see the same `▷ Run Chunk` and `↥ Run Above` buttons after upgrade.
 */
const DEFAULT_LENS_COMMAND_IDS: readonly string[] = [
    'raven.runCurrentChunk',
    'raven.runAboveChunks',
];

/**
 * Read the user's `raven.chunks.codeLens.commands` array and filter it down to
 * known command ids in `CHUNK_LENS_COMMANDS`. Returns the defaults when the
 * setting is unset, empty, or contains only unknown ids.
 *
 * Unknown ids are silently dropped — VS Code would surface a "command not
 * found" error per click if we passed them through, and that's worse UX than
 * just omitting the lens.
 */
function resolve_lens_command_ids(document: vscode.TextDocument): readonly string[] {
    const config = vscode.workspace.getConfiguration(undefined, document.uri);
    const raw = config.get<unknown>(CODELENS_COMMANDS_SETTING);
    if (!Array.isArray(raw)) return DEFAULT_LENS_COMMAND_IDS;
    const filtered = raw.filter(
        (id): id is string => typeof id === 'string' && id in CHUNK_LENS_COMMANDS,
    );
    return filtered.length > 0 ? filtered : DEFAULT_LENS_COMMAND_IDS;
}

/**
 * CodeLens provider that places one or more "Run …" buttons on every R chunk
 * header in `.Rmd` / `.qmd` / `.R` documents. The set of buttons (and their
 * order) is controlled by `raven.chunks.codeLens.commands`; set the array to
 * `[]` to hide all lenses while keeping the run commands available from the
 * palette and keybindings.
 *
 * Non-R chunks (e.g. `{python}`, `{bash}`) are skipped — they aren't executable
 * via the R console.
 *
 * Lens invalidation: VS Code re-calls `provideCodeLenses` (with debouncing)
 * after document edits, visible-range changes, and selector-matching scope
 * shifts. We additionally fire `onDidChangeCodeLenses` when the configuration
 * key changes so a user re-ordering or replacing the lens list sees the new
 * lenses without reopening the file.
 */
class ChunkCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _on_did_change = new vscode.EventEmitter<void>();
    private readonly _config_listener: vscode.Disposable;
    readonly onDidChangeCodeLenses = this._on_did_change.event;

    constructor() {
        this._config_listener = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(CODELENS_COMMANDS_SETTING)) {
                this._on_did_change.fire();
            }
        });
    }

    dispose(): void {
        this._config_listener.dispose();
        this._on_did_change.dispose();
    }

    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
    ): vscode.CodeLens[] {
        const kind = classify_chunk_document_for_document(document);
        // Fast path: plain `.R` files without `# %%` markers (and prose-only
        // `.Rmd` documents) skip the per-line scan entirely.
        if (!has_chunk_anchor(document.getText(), kind)) return [];
        const lens_command_ids = resolve_lens_command_ids(document);
        if (lens_command_ids.length === 0) return [];
        const lines: string[] = [];
        for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
        const chunks = detect_chunks(lines, kind);
        const lenses: vscode.CodeLens[] = [];
        let chunk_index = 0;
        for (const c of chunks) {
            chunk_index++;
            if (!is_runnable_chunk(c)) continue;
            const range = new vscode.Range(c.header_line, 0, c.header_line, 0);
            for (const id of lens_command_ids) {
                const meta = CHUNK_LENS_COMMANDS[id];
                if (!meta) continue;
                const eval_suffix = meta.eval_aware && c.is_eval_false ? ' (eval = FALSE)' : '';
                lenses.push(new vscode.CodeLens(range, {
                    title: `${meta.title}${eval_suffix}`,
                    command: meta.positional_id,
                    arguments: [document.uri, c.header_line],
                    tooltip: c.label
                        ? `${meta.tooltip} (chunk "${c.label}")`
                        : `${meta.tooltip} (chunk #${chunk_index})`,
                }));
            }
        }
        return lenses;
    }
}

export function register_chunk_codelens(context: vscode.ExtensionContext): ChunkCodeLensProvider {
    const provider = new ChunkCodeLensProvider();
    context.subscriptions.push(
        // Chunks live in `.R` files (via `# %%` cells) and in `.Rmd` / `.qmd`
        // files (via fenced code blocks). After the language-ID split each
        // file type uses its own `languageId`, so the selector lists all three.
        vscode.languages.registerCodeLensProvider(
            [
                { scheme: 'file', language: 'r' },
                { scheme: 'untitled', language: 'r' },
                { scheme: 'file', language: 'rmd' },
                { scheme: 'untitled', language: 'rmd' },
                { scheme: 'file', language: 'quarto' },
                { scheme: 'untitled', language: 'quarto' },
            ],
            provider,
        ),
        provider,
    );
    return provider;
}
