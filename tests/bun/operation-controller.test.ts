import { describe, it, expect } from 'bun:test';
import { OperationRegistry } from '../../editors/vscode/src/knit/operation-controller';

describe('OperationRegistry', () => {
    it('beginOp registers and returns a started controller', () => {
        const reg = new OperationRegistry();
        const r = reg.beginOp('k1', 'knit-preview');
        expect(r.kind).toBe('started');
        if (r.kind === 'started') {
            expect(r.controller.kind).toBe('knit-preview');
            expect(r.controller.phase).toBe('starting');
            expect(r.controller.cancelled).toBe(false);
        }
    });

    it('second beginOp on same key returns busy with the existing controller', () => {
        const reg = new OperationRegistry();
        const r1 = reg.beginOp('k1', 'knit-preview');
        const r2 = reg.beginOp('k1', 'export-pdf');
        expect(r2.kind).toBe('busy');
        if (r1.kind === 'started' && r2.kind === 'busy') {
            expect(r2.existing).toBe(r1.controller);
        }
    });

    it('endOp clears the slot so a new op can begin', () => {
        const reg = new OperationRegistry();
        const r1 = reg.beginOp('k1', 'knit-preview');
        if (r1.kind === 'started') reg.endOp(r1.controller, 'done');
        const r2 = reg.beginOp('k1', 'export-pdf');
        expect(r2.kind).toBe('started');
    });

    it('current() returns the in-flight controller', () => {
        const reg = new OperationRegistry();
        expect(reg.current('k1')).toBeUndefined();
        const r = reg.beginOp('k1', 'knit-preview');
        expect(reg.current('k1')).toBe(r.kind === 'started' ? r.controller : undefined);
    });

    it('pin and unpin track preview-dir refcount', () => {
        const reg = new OperationRegistry();
        expect(reg.previewRefs('p1')).toBe(0);
        reg.pinPreviewDir('p1');
        expect(reg.previewRefs('p1')).toBe(1);
        reg.pinPreviewDir('p1');
        expect(reg.previewRefs('p1')).toBe(2);
        reg.unpinPreviewDir('p1');
        expect(reg.previewRefs('p1')).toBe(1);
        reg.unpinPreviewDir('p1');
        expect(reg.previewRefs('p1')).toBe(0);
    });

    it('updatePhase broadcasts to listener; endOp broadcasts final phase', () => {
        const reg = new OperationRegistry();
        const events: string[] = [];
        const r = reg.beginOp('k1', 'knit-preview', { broadcast: (p: string) => events.push(p) });
        if (r.kind === 'started') {
            r.controller.updatePhase('knitting');
            r.controller.updatePhase('finalizing');
            reg.endOp(r.controller, 'done');
        }
        expect(events).toEqual(['starting', 'knitting', 'finalizing', 'done']);
    });

    it('cancel() sets cancelled flag without changing phase', () => {
        const reg = new OperationRegistry();
        const r = reg.beginOp('k1', 'export-pdf');
        if (r.kind === 'started') {
            r.controller.cancel();
            expect(r.controller.cancelled).toBe(true);
            expect(r.controller.phase).toBe('starting');
        }
    });

    it('two concurrent beginOp calls before any await collapse to one started + one busy', () => {
        // Simulates the race: two command invocations both call beginOp
        // synchronously. Only the first wins; the second sees busy.
        const reg = new OperationRegistry();
        const a = reg.beginOp('k1', 'export-pdf');
        const b = reg.beginOp('k1', 'export-pdf');
        expect(a.kind).toBe('started');
        expect(b.kind).toBe('busy');
    });

    it('requestPreviewDirDeletion fires the deleter on the next macrotask when no pins held', async () => {
        // Deferred via setImmediate so a same-tick `pinPreviewDir` +
        // `cancelPreviewDirDeletion` (the close-panel-then-knit race)
        // can rescue the directory before the unrecoverable fs.rm
        // starts. Sync test was tightened to await the macrotask
        // boundary on purpose.
        const reg = new OperationRegistry();
        const deleted: Array<[string, string]> = [];
        reg.setPreviewDirDeleter((dir, key) => { deleted.push([dir, key]); });
        reg.requestPreviewDirDeletion('p1', '/tmp/preview/p1');
        expect(deleted).toEqual([]);
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(deleted).toEqual([['/tmp/preview/p1', 'p1']]);
    });

    it('requestPreviewDirDeletion bails when a pin lands before the deferred fire', async () => {
        // This is the race the macrotask boundary is for: the panel
        // is disposed (deletion requested, no pins) but a brand-new
        // knit on the same source pins + cancels before the rm runs.
        const reg = new OperationRegistry();
        const deleted: string[] = [];
        reg.setPreviewDirDeleter((dir) => { deleted.push(dir); });
        reg.requestPreviewDirDeletion('p1', '/tmp/preview/p1');
        // Synchronously: a new op pins and cancels the deletion.
        reg.pinPreviewDir('p1');
        reg.cancelPreviewDirDeletion('p1');
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(deleted).toEqual([]);
    });

    it('requestPreviewDirDeletion defers when pins are held; fires on last unpin', () => {
        const reg = new OperationRegistry();
        const deleted: string[] = [];
        reg.setPreviewDirDeleter((dir) => { deleted.push(dir); });
        reg.pinPreviewDir('p1');
        reg.pinPreviewDir('p1');
        reg.requestPreviewDirDeletion('p1', '/tmp/preview/p1');
        expect(deleted).toEqual([]);
        reg.unpinPreviewDir('p1');
        expect(deleted).toEqual([]);
        reg.unpinPreviewDir('p1');
        expect(deleted).toEqual(['/tmp/preview/p1']);
    });

    it('requestPreviewDirDeletion only fires once even with multiple requests while pinned', () => {
        const reg = new OperationRegistry();
        const deleted: string[] = [];
        reg.setPreviewDirDeleter((dir) => { deleted.push(dir); });
        reg.pinPreviewDir('p1');
        reg.requestPreviewDirDeletion('p1', '/tmp/preview/p1');
        reg.requestPreviewDirDeletion('p1', '/tmp/preview/p1');
        reg.unpinPreviewDir('p1');
        expect(deleted).toEqual(['/tmp/preview/p1']);
    });

    it('cancelPreviewDirDeletion drops a deferred deletion before the last unpin', () => {
        const reg = new OperationRegistry();
        const deleted: string[] = [];
        reg.setPreviewDirDeleter((dir) => { deleted.push(dir); });
        reg.pinPreviewDir('p1');
        reg.requestPreviewDirDeletion('p1', '/tmp/preview/p1');
        reg.cancelPreviewDirDeletion('p1');
        reg.unpinPreviewDir('p1');
        expect(deleted).toEqual([]);
    });
});
