/**
 * Phase 5 on the host: Copy as R code, go to row, find, and refresh,
 * through a real DataViewerPanel (in-process engine) on the tiny fixture
 * and a fake webview, like the panel transform suites.
 *
 * tiny.x = [1, 2, 3, 4, 5]; tiny.s = [a, b, NA, d, e].
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIX = '/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/test-fixtures/data-viewer/tiny.arrow';
let warnings: string[] = [];
let outputLines: string[] = [];
let clipboard: string[] = [];
let infos: string[] = [];
let modalAnswer: string | undefined;
let modals: { msg: string; detail?: string }[] = [];
let sent: string[] = [];
let opened: string[] = [];

let captured: FakeWebviewPanel;
class MemKV {
    private m = new Map<string, unknown>();
    get<T>(k: string, d?: T): T | undefined { return (this.m.get(k) as T | undefined) ?? d; }
    update(k: string, v: unknown): Thenable<void> {
        if (v === undefined) this.m.delete(k); else this.m.set(k, v);
        return Promise.resolve();
    }
}

class FakeWebview {
    private listener: ((m: any) => void) | null = null;
    posted: any[] = [];
    /** Called for each post; may return a promise to delay it. */
    onPost: ((m: any) => Promise<unknown> | void) | undefined;
    onDidReceiveMessage(cb: (m: any) => void) { this.listener = cb; return { dispose() {} }; }
    postMessage(msg: any): Thenable<boolean> {
        this.posted.push(msg);
        const hold = this.onPost?.(msg);
        return hold ? hold.then(() => true) : Promise.resolve(true);
    }
    asWebviewUri(uri: any) { return uri; }
    cspSource = 'vscode-webview://x';
    deliver(m: any) { this.listener?.(m); }
}

class FakeWebviewPanel {
    webview = new FakeWebview();
    private disposeListeners: (() => void)[] = [];
    onDidDispose(cb: () => void) { this.disposeListeners.push(cb); return { dispose() {} }; }
    reveal() {}
    dispose() { this.disposeListeners.forEach(cb => cb()); }
}

async function flush(n = 6): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
    cleanups.length = 0;
    warnings = [];
    outputLines = [];
    clipboard = [];
    infos = [];
    modals = [];
    sent = [];
    opened = [];
    modalAnswer = undefined;
    mock.restore();
});

async function setup(opts: { savedSort?: any; savedFilter?: any; source?: any; persistSort?: boolean; title?: string } = {}) {
    mock.module('vscode', () => ({
        window: {
            createWebviewPanel: () => (captured = new FakeWebviewPanel()),
            createOutputChannel: () => ({ appendLine: (l: string) => outputLines.push(l), dispose() {} }),
            showWarningMessage: (msg: string, opts?: any) => {
                if (opts?.modal) { modals.push({ msg, detail: opts.detail }); return Promise.resolve(modalAnswer); }
                warnings.push(msg);
                return Promise.resolve(undefined);
            },
            showInformationMessage: (msg: string) => { infos.push(msg); return Promise.resolve(undefined); },
        },
        workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
        env: {
            clipboard: { writeText: async (t: string) => { clipboard.push(t); } },
            openExternal: async (u: { toString(): string }) => { opened.push(u.toString()); return true; },
        },
        Uri: { parse: (s: string) => ({ toString: () => s }), joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base?.fsPath ?? '', ...parts].join('/') }) },
        ViewColumn: { Active: -1 },
    }));
    mock.module('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/send-to-r/r-terminal-manager', () => ({
        // Refresh re-runs only in the session that made the view.
        terminal_for_session: (id: string) => (id === 'live' ? { name: 'R' } : undefined),
    }));
    mock.module('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/send-to-r/send-code', () => ({
        get_send_options: () => ({ sendMethod: 'auto', autoTempFileThresholdLines: 25 }),
        send_code: (_t: unknown, code: string) => { sent.push(code); },
    }));
    const panelMod = await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/panel');
    const arrowMod = await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/arrow-reader');
    const { LayoutStore, schemaHash } = await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/layout-state');
    const { ToolbarStateStore } = await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/toolbar-state');
    const { SortStateStore } = await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/sort-state');
    const { FilterStateStore } = await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/filter-state');
    const kv = new MemKV();
    const sortStore = new SortStateStore(kv as any, 100);
    const filterStore = new FilterStateStore(kv as any, 100);
    const dir = mkdtempSync(join(tmpdir(), 'raven-transforms-'));
    const path = join(dir, 'tiny.arrow');
    copyFileSync(FIX, path);
    const reader = await arrowMod.ArrowSliceReader.open(path);
    cleanups.push(() => reader.close().catch(() => undefined));
    const hash = schemaHash(reader.schema.columns);
    if (opts.savedSort) await sortStore.save('tiny', hash, opts.savedSort);
    if (opts.savedFilter) await filterStore.save('tiny', hash, opts.savedFilter);
    const panel: any = await panelMod.DataViewerPanel.create(
        opts.title ?? 'tiny', reader, path,
        new LayoutStore(kv as any, 100), new ToolbarStateStore(kv as any, 100), sortStore, filterStore,
        { missingValueStyle: 'foreground', defaultDigits: 3, persistSort: opts.persistSort ?? true, persistFilters: true, uiLocale: 'en' },
        { fsPath: '/no-dist' } as any,
        () => {},
        opts.source ?? {},
    );
    const fake = panel.webviewPanel as FakeWebviewPanel;
    cleanups.push(() => fake.dispose());
    const wv = fake.webview;
    return { panel, wv, reader, sortStore, filterStore, hash, arrowMod, dir };
}



test('close during worker startup',async()=>{
 const {panel,dir,reader}=await setup();
 const {WorkerEngine}=await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/worker-engine')
 const {DataViewerManager}=await import('/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode/src/data-viewer/manager')
 const orig=WorkerEngine.start
 let release:()=>void, ready:()=>void, eng:any
 const held=new Promise<void>(r=>release=r)
 const started=new Promise<void>(r=>ready=r)
 WorkerEngine.start=async function(opts){eng=await orig.call(this,opts);ready();await held;return eng}
 try {
 const kv=new MemKV()
 const mgr=new DataViewerManager({fsPath:'/Users/jmb/.t3/worktrees/raven/t3-fb02e772-60ee33a3509ac213/editors/vscode'} as any,panel.store,panel.toolbarStore,panel.sortStore,panel.filterStore,()=>panel.settings)
 const fp=join(dir,'opened.arrow')
 copyFileSync(FIX,fp)
 const opened=mgr.onViewDataRequested({panelName:'race',filePath:fp,nrow:5,sessionId:'x'} as any)
 await started

 const wv=captured.webview
 wv.deliver({type:'webviewReady',adoptsTransforms:true})
 for(let i=0;i<100&&!wv.posted.some(m=>m.type==='init');i++)await flush(1)
 console.log('init before workers handed back',wv.posted.find(m=>m.type==='init'))
 release()
 await opened
 for(let i=0;i<100&&!wv.posted.some(m=>m.type==='init');i++)await flush(1)
 const init=wv.posted.find(m=>m.type==='init')
 console.log('init after',init.transformGeneration)
 wv.deliver({type:'adopted',panelGeneration:init.panelGeneration,transformGeneration:init.transformGeneration})
 wv.deliver({type:'getRows',panelGeneration:init.panelGeneration,transformGeneration:init.transformGeneration,requestId:111,viewportGeneration:1,start:0,end:5,columns:[0]})
 await flush(20)
 console.log('committed worker gen',eng.coordinator.committed.gen,'log',outputLines,'row replies',wv.posted.filter(m=>m.type==='rows'))
 expect(wv.posted.some(m=>m.type==='rows')).toBe(true)
 captured.dispose()
 }finally{WorkerEngine.start=orig;release();await eng?.dispose()}
})
