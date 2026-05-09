import { describe, test, expect, beforeEach } from 'bun:test';
import {
    ToolbarStateStore,
    type ToolbarState,
} from '../../editors/vscode/src/data-viewer/toolbar-state';

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

const tb = (over: Partial<ToolbarState> = {}): ToolbarState => ({
    labelsOn: true, formatOn: true, digits: 3, ...over,
});

describe('ToolbarStateStore', () => {
    let kv: MemKV;
    let store: ToolbarStateStore;
    beforeEach(() => {
        kv = new MemKV();
        store = new ToolbarStateStore(kv as any, 3);
    });

    test('save then load by composite key', async () => {
        await store.save('mtcars', 'h1', tb({ formatOn: false, digits: 5 }));
        const got = await store.load('mtcars', 'h1');
        expect(got).toEqual(tb({ formatOn: false, digits: 5 }));
    });

    test('load returns undefined for unknown key', async () => {
        expect(await store.load('mtcars', 'never')).toBeUndefined();
    });

    test('different schemaHash gives a separate slot', async () => {
        await store.save('mtcars', 'h1', tb({ digits: 1 }));
        await store.save('mtcars', 'h2', tb({ digits: 2 }));
        expect((await store.load('mtcars', 'h1'))!.digits).toBe(1);
        expect((await store.load('mtcars', 'h2'))!.digits).toBe(2);
    });

    test('different panelName under same hash is independent', async () => {
        await store.save('A', 'h', tb({ labelsOn: false }));
        await store.save('B', 'h', tb({ labelsOn: true }));
        expect((await store.load('A', 'h'))!.labelsOn).toBe(false);
        expect((await store.load('B', 'h'))!.labelsOn).toBe(true);
    });

    test('LRU evicts oldest when capacity exceeded', async () => {
        for (let i = 0; i < 5; i++) {
            await store.save(`p${i}`, 'h', tb());
        }
        expect(await store.load('p0', 'h')).toBeUndefined();
        expect(await store.load('p1', 'h')).toBeUndefined();
        expect(await store.load('p2', 'h')).toBeDefined();
        expect(await store.load('p3', 'h')).toBeDefined();
        expect(await store.load('p4', 'h')).toBeDefined();
    });

    test('re-saving an existing key resets its LRU position', async () => {
        await store.save('p0', 'h', tb());
        await store.save('p1', 'h', tb());
        await store.save('p2', 'h', tb());
        await store.save('p0', 'h', tb({ digits: 9 }));
        await store.save('p3', 'h', tb()); // evicts p1
        expect((await store.load('p0', 'h'))!.digits).toBe(9);
        expect(await store.load('p1', 'h')).toBeUndefined();
        expect(await store.load('p2', 'h')).toBeDefined();
        expect(await store.load('p3', 'h')).toBeDefined();
    });

    test('order index never grows unbounded', async () => {
        for (let i = 0; i < 20; i++) {
            await store.save(`p${i}`, 'h', tb());
        }
        const order = (kv as any).get<string[]>('raven.dataViewer.toolbarOrder') ?? [];
        expect(order.length).toBeLessThanOrEqual(3);
    });
});
