import { describe, test, expect, beforeEach } from 'bun:test';
import { LayoutStore, schemaHash } from '../../editors/vscode/src/data-viewer/layout-state';
import type { Layout } from '../../editors/vscode/src/data-viewer/messages';

class MemKV {
    private m = new Map<string, unknown>();
    get<T>(k: string, d?: T): T | undefined {
        return (this.m.get(k) as T | undefined) ?? d;
    }
    update(k: string, v: unknown): Thenable<void> {
        if (v === undefined) this.m.delete(k);
        else this.m.set(k, v);
        return Promise.resolve();
    }
    keys(): string[] { return Array.from(this.m.keys()); }
}

const layout = (): Layout => ({ columnWidths: { x: 100 }, hiddenColumns: [] });

describe('schemaHash', () => {
    test('stable across calls', () => {
        const s = [
            { name: 'a', arrowType: 'Int32' },
            { name: 'b', arrowType: 'Utf8' },
        ];
        expect(schemaHash(s)).toBe(schemaHash(s));
    });
    test('differs when types differ', () => {
        const a = [{ name: 'a', arrowType: 'Int32' }];
        const b = [{ name: 'a', arrowType: 'Float64' }];
        expect(schemaHash(a)).not.toBe(schemaHash(b));
    });
    test('differs when names differ', () => {
        const a = [{ name: 'a', arrowType: 'Int32' }];
        const b = [{ name: 'b', arrowType: 'Int32' }];
        expect(schemaHash(a)).not.toBe(schemaHash(b));
    });
    test('order-sensitive', () => {
        const a = [{ name: 'a', arrowType: 'Int32' }, { name: 'b', arrowType: 'Utf8' }];
        const b = [{ name: 'b', arrowType: 'Utf8' }, { name: 'a', arrowType: 'Int32' }];
        expect(schemaHash(a)).not.toBe(schemaHash(b));
    });
});

describe('LayoutStore', () => {
    let kv: MemKV;
    let store: LayoutStore;
    beforeEach(() => {
        kv = new MemKV();
        store = new LayoutStore(kv as any, 3);
    });

    test('save then load by composite key', async () => {
        await store.save('mtcars', 'h1', layout());
        const got = await store.load('mtcars', 'h1');
        expect(got).toEqual(layout());
    });

    test('load returns undefined for unknown key', async () => {
        const got = await store.load('mtcars', 'h-never-saved');
        expect(got).toBeUndefined();
    });

    test('different schemaHash gives a separate slot', async () => {
        await store.save('mtcars', 'h1', { columnWidths: { x: 1 }, hiddenColumns: [] });
        await store.save('mtcars', 'h2', { columnWidths: { x: 2 }, hiddenColumns: [] });
        expect((await store.load('mtcars', 'h1'))!.columnWidths.x).toBe(1);
        expect((await store.load('mtcars', 'h2'))!.columnWidths.x).toBe(2);
    });

    test('LRU evicts oldest when capacity exceeded', async () => {
        for (let i = 0; i < 5; i++) {
            await store.save(`p${i}`, 'h', layout());
        }
        // capacity = 3, so p0 and p1 are evicted, p2..p4 remain
        expect(await store.load('p0', 'h')).toBeUndefined();
        expect(await store.load('p1', 'h')).toBeUndefined();
        expect(await store.load('p2', 'h')).toBeDefined();
        expect(await store.load('p3', 'h')).toBeDefined();
        expect(await store.load('p4', 'h')).toBeDefined();
    });

    test('re-saving an existing key resets its LRU position', async () => {
        await store.save('p0', 'h', layout());
        await store.save('p1', 'h', layout());
        await store.save('p2', 'h', layout());
        // Touch p0; p1 should now be the eldest.
        await store.save('p0', 'h', layout());
        await store.save('p3', 'h', layout()); // evicts p1
        expect(await store.load('p0', 'h')).toBeDefined();
        expect(await store.load('p1', 'h')).toBeUndefined();
        expect(await store.load('p2', 'h')).toBeDefined();
        expect(await store.load('p3', 'h')).toBeDefined();
    });

    test('order index never grows unbounded', async () => {
        for (let i = 0; i < 20; i++) {
            await store.save(`p${i}`, 'h', layout());
        }
        const order = (kv as any).get<string[]>('raven.dataViewer.layoutOrder') ?? [];
        expect(order.length).toBeLessThanOrEqual(3);
    });
});
