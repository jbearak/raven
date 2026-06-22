import { describe, it, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    adoptPreviewArtifacts,
    selectStaleSessionDirs,
    listSessionDirs,
    ravenKnitRoot,
    type AdoptIo,
    type SessionDirInfo,
} from '../../editors/vscode/src/knit/preview-persistence';
import {
    initSessionState,
    cleanupCurrentSession,
    __resetSessionStateForTests,
} from '../../editors/vscode/src/knit/session-state';
import {
    computeWorkspaceHash,
    sessionRoot,
    previewDirFor,
    exportDirFor,
} from '../../editors/vscode/src/knit/raven-knit-paths';

// All adoption tests operate inside the real raven-knit root so the
// containment check passes for legitimately-placed fixtures.
const KNIT_ROOT = ravenKnitRoot();
fs.mkdirSync(KNIT_ROOT, { recursive: true });
const fixtures: string[] = [];

function freshPreviewDir(label: string): { previewDir: string; htmlPath: string } {
    const dir = fs.mkdtempSync(path.join(KNIT_ROOT, `test-${label}-`));
    fixtures.push(dir);
    return { previewDir: dir, htmlPath: path.join(dir, 'doc.html') };
}

afterAll(() => {
    for (const f of fixtures) {
        try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe('adoptPreviewArtifacts', () => {
    it('reuses the current-session HTML when it already exists', () => {
        const cur = freshPreviewDir('reuse');
        fs.writeFileSync(cur.htmlPath, '<html>current</html>');
        // Persisted path is some other (existing) location, but reuse wins.
        const old = freshPreviewDir('reuse-old');
        fs.writeFileSync(old.htmlPath, '<html>old</html>');

        const out = adoptPreviewArtifacts(cur, old.htmlPath);
        expect(out.reason).toBe('reused');
        expect(out.available).toBe(true);
        expect(out.htmlPath).toBe(cur.htmlPath);
        // Old dir untouched.
        expect(fs.existsSync(old.htmlPath)).toBe(true);
    });

    it('adopts the old dir when the current session has no output yet', () => {
        // Current preview dir does NOT exist yet.
        const curDir = path.join(KNIT_ROOT, `test-adopt-new-${process.pid}-${Math.floor(performance.now())}`);
        const cur = { previewDir: curDir, htmlPath: path.join(curDir, 'doc.html') };
        fixtures.push(curDir);

        const old = freshPreviewDir('adopt-old');
        fs.writeFileSync(old.htmlPath, '<html>old</html>');
        fs.mkdirSync(path.join(old.previewDir, 'figure'), { recursive: true });
        fs.writeFileSync(path.join(old.previewDir, 'figure', 'p.png'), 'x');

        const out = adoptPreviewArtifacts(cur, old.htmlPath);
        expect(out.reason).toBe('adopted');
        expect(out.available).toBe(true);
        expect(out.htmlPath).toBe(cur.htmlPath);
        // Artifacts now live at the current path, including figures.
        expect(fs.readFileSync(cur.htmlPath, 'utf-8')).toBe('<html>old</html>');
        expect(fs.existsSync(path.join(curDir, 'figure', 'p.png'))).toBe(true);
        // Old dir moved away.
        expect(fs.existsSync(old.previewDir)).toBe(false);
    });

    it('reports missing-source when the persisted artifact is gone', () => {
        const curDir = path.join(KNIT_ROOT, `test-missing-${process.pid}-${Math.floor(performance.now())}`);
        const cur = { previewDir: curDir, htmlPath: path.join(curDir, 'doc.html') };
        // Old preview dir survived but its HTML was swept — parent exists so
        // the containment check resolves deterministically; the file does not.
        const oldDir = freshPreviewDir('gone-old').previewDir;
        const goneOld = path.join(oldDir, 'doc.html');

        const out = adoptPreviewArtifacts(cur, goneOld);
        expect(out.reason).toBe('missing-source');
        expect(out.available).toBe(false);
        expect(out.htmlPath).toBe(cur.htmlPath);
        expect(fs.existsSync(curDir)).toBe(false);
    });

    it('rejects a persisted path outside the raven-knit tree', () => {
        const cur = freshPreviewDir('reject');
        const outside = path.join(os.tmpdir(), 'definitely-not-raven-knit', 'evil.html');
        const out = adoptPreviewArtifacts(cur, outside);
        expect(out.reason).toBe('rejected-path');
        expect(out.available).toBe(false);
    });

    it('rejects an empty persisted path', () => {
        const cur = freshPreviewDir('reject-empty');
        const out = adoptPreviewArtifacts(cur, '');
        expect(out.reason).toBe('rejected-path');
        expect(out.available).toBe(false);
    });

    it('does not clobber a current dir that exists without HTML (knit in progress)', () => {
        const cur = freshPreviewDir('inprogress'); // dir exists, no html
        const old = freshPreviewDir('inprogress-old');
        fs.writeFileSync(old.htmlPath, '<html>old</html>');

        const out = adoptPreviewArtifacts(cur, old.htmlPath);
        expect(out.reason).toBe('in-progress');
        expect(out.available).toBe(false);
        // Old dir left intact (not moved into the live dir).
        expect(fs.existsSync(old.htmlPath)).toBe(true);
        expect(fs.existsSync(cur.htmlPath)).toBe(false);
    });

    it('falls back to copy+remove when rename fails (EXDEV)', () => {
        const curDir = path.join(KNIT_ROOT, `test-exdev-${process.pid}-${Math.floor(performance.now())}`);
        const cur = { previewDir: curDir, htmlPath: path.join(curDir, 'doc.html') };
        fixtures.push(curDir);
        const old = freshPreviewDir('exdev-old');
        fs.writeFileSync(old.htmlPath, '<html>old</html>');

        let renameCalled = false;
        let cpCalled = false;
        const io: AdoptIo = {
            existsSync: (p) => fs.existsSync(p),
            renameSync: () => {
                renameCalled = true;
                const e = new Error('cross-device link') as NodeJS.ErrnoException;
                e.code = 'EXDEV';
                throw e;
            },
            cpSync: (src, dst) => { cpCalled = true; fs.cpSync(src, dst, { recursive: true }); },
            rmSync: (p) => fs.rmSync(p, { recursive: true, force: true }),
            mkdirSync: (p) => { fs.mkdirSync(p, { recursive: true }); },
            touch: () => { /* noop */ },
        };

        const out = adoptPreviewArtifacts(cur, old.htmlPath, io);
        expect(renameCalled).toBe(true);
        expect(cpCalled).toBe(true);
        expect(out.reason).toBe('adopted');
        expect(out.available).toBe(true);
        expect(fs.readFileSync(cur.htmlPath, 'utf-8')).toBe('<html>old</html>');
        expect(fs.existsSync(old.previewDir)).toBe(false);
    });
});

describe('selectStaleSessionDirs', () => {
    const now = 1_000_000_000;
    const threshold = 5 * 60 * 1000; // 5 minutes
    const mk = (sessionId: string, ageMs: number): SessionDirInfo => ({
        path: `/tmp/raven-knit/wh/${sessionId}`,
        sessionId,
        recencyMs: now - ageMs,
    });

    it('never removes the current session', () => {
        const sessions = [mk('cur', 99 * 60 * 1000)]; // very old, but current
        const out = selectStaleSessionDirs({
            sessions,
            currentSessionId: 'cur',
            nowMs: now,
            ageThresholdMs: threshold,
        });
        expect(out).toEqual([]);
    });

    it('protects sessions touched within the age threshold', () => {
        const sessions = [mk('other', 60 * 1000)]; // 1 min ago < 5 min
        const out = selectStaleSessionDirs({
            sessions,
            currentSessionId: 'cur',
            nowMs: now,
            ageThresholdMs: threshold,
        });
        expect(out).toEqual([]);
    });

    it('removes other sessions older than the threshold', () => {
        const sessions = [mk('stale', 10 * 60 * 1000)]; // 10 min ago
        const out = selectStaleSessionDirs({
            sessions,
            currentSessionId: 'cur',
            nowMs: now,
            ageThresholdMs: threshold,
        });
        expect(out).toEqual(['/tmp/raven-knit/wh/stale']);
    });

    it('mixes the rules correctly', () => {
        const sessions = [
            mk('cur', 99 * 60 * 1000),   // current → keep
            mk('fresh', 60 * 1000),      // recent → keep
            mk('stale1', 6 * 60 * 1000), // old → remove
            mk('stale2', 8 * 60 * 1000), // old → remove
        ];
        const out = selectStaleSessionDirs({
            sessions,
            currentSessionId: 'cur',
            nowMs: now,
            ageThresholdMs: threshold,
        });
        expect(out.sort()).toEqual(
            ['/tmp/raven-knit/wh/stale1', '/tmp/raven-knit/wh/stale2'].sort(),
        );
    });
});

describe('listSessionDirs', () => {
    it('returns one entry per <workspaceHash>/<sessionId> dir with recency', async () => {
        const root = fs.mkdtempSync(path.join(KNIT_ROOT, 'list-'));
        fixtures.push(root);
        // <root>/wh1/sessA/preview/h, <root>/wh1/sessB, <root>/wh2/sessC
        const a = path.join(root, 'wh1', 'sessA', 'preview', 'h');
        const b = path.join(root, 'wh1', 'sessB');
        const c = path.join(root, 'wh2', 'sessC');
        fs.mkdirSync(a, { recursive: true });
        fs.writeFileSync(path.join(a, 'doc.html'), 'x');
        fs.mkdirSync(b, { recursive: true });
        fs.mkdirSync(c, { recursive: true });
        // A stray file at the workspace level must be ignored.
        fs.writeFileSync(path.join(root, 'wh1', 'stray.txt'), 'x');

        const out = await listSessionDirs(root);
        const ids = out.map((s) => s.sessionId).sort();
        expect(ids).toEqual(['sessA', 'sessB', 'sessC']);
        for (const s of out) {
            expect(s.recencyMs).toBeGreaterThan(0);
        }
    });

    it('returns [] when the root does not exist', async () => {
        const out = await listSessionDirs(path.join(KNIT_ROOT, 'does-not-exist-xyz'));
        expect(out).toEqual([]);
    });
});

describe('cleanupCurrentSession persistPreview gating', () => {
    const wsUri = `file:///tmp/raven-persist-test-${process.pid}`;
    const sessionId = `sess-${process.pid}-${Math.floor(performance.now())}`;
    const wh = computeWorkspaceHash(wsUri);
    const root = sessionRoot(wh, sessionId);

    afterAll(() => {
        __resetSessionStateForTests();
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function seed(): { previewHtml: string; exportFile: string } {
        const previewDir = previewDirFor(wh, sessionId, 'srchash');
        const exportDir = exportDirFor(wh, sessionId, 'expuuid');
        fs.mkdirSync(previewDir, { recursive: true });
        fs.mkdirSync(exportDir, { recursive: true });
        const previewHtml = path.join(previewDir, 'doc.html');
        const exportFile = path.join(exportDir, 'out.html');
        fs.writeFileSync(previewHtml, '<html></html>');
        fs.writeFileSync(exportFile, '<html></html>');
        return { previewHtml, exportFile };
    }

    it('keeps preview dirs but removes export when persistPreview=true', async () => {
        __resetSessionStateForTests();
        initSessionState({ sessionId, workspaceUri: wsUri });
        const { previewHtml, exportFile } = seed();

        await cleanupCurrentSession(true);

        expect(fs.existsSync(previewHtml)).toBe(true);
        expect(fs.existsSync(path.join(root, 'export'))).toBe(false);
        expect(fs.existsSync(exportFile)).toBe(false);
    });

    it('removes the whole session root when persistPreview=false', async () => {
        __resetSessionStateForTests();
        initSessionState({ sessionId, workspaceUri: wsUri });
        seed();

        await cleanupCurrentSession(false);

        expect(fs.existsSync(root)).toBe(false);
    });
});
