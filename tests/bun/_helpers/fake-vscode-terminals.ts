/**
 * A small in-memory `vscode` for driving the send-to-R modules
 * (`editors/vscode/src/send-to-r/`) under bun: settings with user and
 * workspace layers, terminals with an active one, events, and the few
 * classes those modules construct. Each test file registers it with
 * `mock.module('vscode', () => fake.module)` before importing the modules;
 * every top-level key here must also be in `vscode-mock-preload.ts`.
 */

type Listener<T> = (value: T) => void;

class Emitter<T> {
    private listeners = new Set<Listener<T>>();
    event = (listener: Listener<T>) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
        for (const l of [...this.listeners]) l(value);
    }
    clear(): void {
        this.listeners.clear();
    }
}

export type FakeTerminal = {
    name: string;
    creationOptions: Record<string, unknown>;
    exitStatus: undefined | { code: number };
    typed: string[];
    sendText(text: string, add_newline?: boolean): void;
    show(preserve_focus?: boolean): void;
    dispose(): void;
};

export type Warning = { message: string; items: string[] };

export function make_fake_vscode() {
    const settings = new Map<string, { global?: unknown; workspace?: unknown }>();
    const terminals: FakeTerminal[] = [];
    const on_open = new Emitter<FakeTerminal>();
    const on_close = new Emitter<FakeTerminal>();
    const on_active = new Emitter<FakeTerminal | undefined>();
    const on_config = new Emitter<{ affectsConfiguration(s: string): boolean }>();
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const warnings: Warning[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const state = {
        /** Answers `showWarningMessage`; the default dismisses it. */
        answer_warning: (_w: Warning): string | undefined => undefined,
        /** Whether `terminal.show()` makes the terminal active. */
        show_activates: true,
        extensions: new Map<string, unknown>(),
    };

    const window = {
        terminals,
        activeTerminal: undefined as FakeTerminal | undefined,
        activeTextEditor: undefined,
        createTerminal(options: Record<string, unknown>): FakeTerminal {
            const terminal: FakeTerminal = {
                name: String(options.name ?? ''),
                creationOptions: options,
                exitStatus: undefined,
                typed: [],
                sendText(text: string) { this.typed.push(text); },
                show() {
                    if (!state.show_activates) return;
                    // VS Code updates the active terminal asynchronously.
                    queueMicrotask(() => {
                        if (window.activeTerminal === terminal) return;
                        window.activeTerminal = terminal;
                        on_active.fire(terminal);
                    });
                },
                dispose() {
                    const i = terminals.indexOf(terminal);
                    if (i >= 0) terminals.splice(i, 1);
                    on_close.fire(terminal);
                },
            };
            terminals.push(terminal);
            on_open.fire(terminal);
            return terminal;
        },
        onDidOpenTerminal: on_open.event,
        onDidCloseTerminal: on_close.event,
        onDidChangeActiveTerminal: on_active.event,
        registerTerminalProfileProvider: () => ({ dispose() {} }),
        showWarningMessage: async (message: string, ...items: string[]) => {
            const w = { message, items };
            warnings.push(w);
            return state.answer_warning(w);
        },
        showErrorMessage: async (message: string) => { errors.push(message); return undefined; },
        showInformationMessage: async (message: string) => { infos.push(message); return undefined; },
        showQuickPick: async () => undefined,
        createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
        createWebviewPanel: () => { throw new Error('not stubbed'); },
        withProgress: async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
            task({}, { onCancellationRequested: () => ({ dispose() {} }) }),
    };

    function value_of(key: string): unknown {
        const v = settings.get(key);
        return v?.workspace !== undefined ? v.workspace : v?.global;
    }

    const workspace = {
        workspaceFolders: undefined,
        fs: { readFile: async () => new Uint8Array() },
        getWorkspaceFolder: () => undefined,
        onDidChangeConfiguration: on_config.event,
        getConfiguration(section: string) {
            const full = (key: string) => `${section}.${key}`;
            return {
                get: (key: string, fallback?: unknown) => value_of(full(key)) ?? fallback,
                inspect: (key: string) => ({
                    globalValue: settings.get(full(key))?.global,
                    workspaceValue: settings.get(full(key))?.workspace,
                    workspaceFolderValue: undefined,
                }),
                update: async (key: string, value: unknown, target: unknown) => {
                    const entry = settings.get(full(key)) ?? {};
                    if (target === ConfigurationTarget.Global || target === true) entry.global = value;
                    else entry.workspace = value;
                    settings.set(full(key), entry);
                    const changed = full(key);
                    on_config.fire({ affectsConfiguration: (s: string) => changed === s || changed.startsWith(`${s}.`) });
                },
            };
        },
    };

    const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

    class CancellationError extends Error {
        constructor() { super('Canceled'); this.name = 'Canceled'; }
    }
    class Disposable {
        constructor(private fn: () => void) {}
        dispose() { this.fn(); }
        static from(...items: { dispose(): unknown }[]) {
            return new Disposable(() => items.forEach((i) => i.dispose()));
        }
    }
    class TerminalProfile {
        constructor(public options: Record<string, unknown>) {}
    }
    class CancellationTokenSource {
        token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
        cancel() { this.token.isCancellationRequested = true; }
        dispose() {}
    }
    class Position { constructor(public line: number, public character: number) {} }
    class Range { constructor(public start: Position, public end: Position) {} }
    class Selection extends Range {}
    class ThemeIcon { constructor(public id: string) {} }

    const module = {
        commands: {
            registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
                commands.set(id, fn);
                return { dispose: () => commands.delete(id) };
            },
            executeCommand: async (id: string, ...args: unknown[]) => {
                const fn = commands.get(id);
                if (!fn) throw new Error(`command '${id}' not found`);
                return fn(...args);
            },
        },
        env: {
            remoteName: undefined,
            openExternal: async () => true,
            clipboard: { writeText: async () => undefined },
        },
        extensions: {
            getExtension: (id: string) => state.extensions.get(id),
            onDidChange: () => ({ dispose() {} }),
        },
        ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
        Uri: {
            file: (fsPath: string) => ({ fsPath, path: fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
            parse: (value: string) => ({ fsPath: value, path: value, scheme: value.split(':', 1)[0], toString: () => value }),
            joinPath: (base: { fsPath?: string } | undefined, ...parts: string[]) => ({
                fsPath: [base?.fsPath ?? '', ...parts].join('/'),
                toString: () => parts.join('/'),
            }),
        },
        ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
        ExtensionKind: { UI: 1, Workspace: 2 },
        ConfigurationTarget,
        CancellationError,
        CancellationTokenSource,
        Disposable,
        TerminalProfile,
        Position,
        Range,
        Selection,
        ThemeIcon,
        window,
        workspace,
    };

    return {
        module,
        window,
        warnings,
        errors,
        infos,
        state,
        commands,
        /** Sets a setting without firing a change event (initial state). */
        set_setting(key: string, layer: 'global' | 'workspace', value: unknown): void {
            const entry = settings.get(key) ?? {};
            entry[layer] = value;
            settings.set(key, entry);
        },
        setting(key: string, layer: 'global' | 'workspace'): unknown {
            return settings.get(key)?.[layer];
        },
        reset(): void {
            settings.clear();
            terminals.splice(0);
            window.activeTerminal = undefined;
            warnings.splice(0);
            errors.splice(0);
            infos.splice(0);
            commands.clear();
            state.answer_warning = () => undefined;
            state.show_activates = true;
            state.extensions.clear();
            on_open.clear();
            on_close.clear();
            on_active.clear();
            on_config.clear();
        },
    };
}

export type FakeVscode = ReturnType<typeof make_fake_vscode>;
