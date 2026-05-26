/**
 * SortStateStore — persistence parity with ToolbarStateStore.
 *
 * The store is keyed by panelName + schemaHash and shares the same LRU
 * cap as the layout/toolbar stores. These tests cover the save/load
 * round-trip, LRU eviction at the cap, clear, and isolation between
 * panel names with the same schema hash.
 */

import { describe, test, expect } from 'bun:test';
import { SortStateStore } from '../../editors/vscode/src/data-viewer/sort-state';
import type { SortState } from '../../editors/vscode/src/data-viewer/messages';

class MemKV {
    private m = new Map<string, unknown>();
    get<T>(k: string, d?: T): T | undefined {
        return (this.m.get(k) as T | undefined) ?? d;
    }
    update(k: string, v: unknown): Promise<void> {
        if (v === undefined) this.m.delete(k);
        else this.m.set(k, v);
        return Promise.resolve();
    }
    keys(): string[] {
        return [...this.m.keys()];
    }
}

const STATE_A: SortState = {
    keys: [{ columnIndex: 2, direction: 'asc' }],
    labelsOnWhenSorted: true,
    nrowWhenSorted: 100,
};
const STATE_B: SortState = {
    keys: [
        { columnIndex: 0, direction: 'desc' },
        { columnIndex: 1, direction: 'asc' },
    ],
    labelsOnWhenSorted: false,
    nrowWhenSorted: 1000,
};

describe('SortStateStore', () => {
    test('save then load returns the stored state', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 10);
        await store.save('mtcars', 'abc12345', STATE_A);
        const loaded = await store.load('mtcars', 'abc12345');
        expect(loaded).toEqual(STATE_A);
    });

    test('load returns undefined when no entry has been saved', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 10);
        const loaded = await store.load('mtcars', 'abc12345');
        expect(loaded).toBeUndefined();
    });

    test('different panel names with the same schema hash do not collide', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 10);
        await store.save('mtcars', 'h', STATE_A);
        await store.save('iris', 'h', STATE_B);
        expect(await store.load('mtcars', 'h')).toEqual(STATE_A);
        expect(await store.load('iris', 'h')).toEqual(STATE_B);
    });

    test('saving an existing key overwrites in place (no second slot)', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 10);
        await store.save('p', 'h', STATE_A);
        await store.save('p', 'h', STATE_B);
        expect(await store.load('p', 'h')).toEqual(STATE_B);
        const sortKeys = kv.keys().filter(k => k.startsWith('raven.dataViewer.sort::'));
        expect(sortKeys).toHaveLength(1);
    });

    test('LRU evicts the oldest entry once cap is exceeded', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 2);
        await store.save('a', 'h', STATE_A);
        await store.save('b', 'h', STATE_A);
        await store.save('c', 'h', STATE_A);
        // 'a' should be evicted; b and c retained.
        expect(await store.load('a', 'h')).toBeUndefined();
        expect(await store.load('b', 'h')).toEqual(STATE_A);
        expect(await store.load('c', 'h')).toEqual(STATE_A);
    });

    test('re-saving an entry refreshes its LRU position', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 2);
        await store.save('a', 'h', STATE_A);
        await store.save('b', 'h', STATE_A);
        // Touch 'a' so 'b' becomes the LRU.
        await store.save('a', 'h', STATE_B);
        await store.save('c', 'h', STATE_A);
        // 'b' should be evicted; 'a' and 'c' retained.
        expect(await store.load('a', 'h')).toEqual(STATE_B);
        expect(await store.load('b', 'h')).toBeUndefined();
        expect(await store.load('c', 'h')).toEqual(STATE_A);
    });

    test('clear removes the entry and its order pointer', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 10);
        await store.save('mtcars', 'h', STATE_A);
        await store.clear('mtcars', 'h');
        expect(await store.load('mtcars', 'h')).toBeUndefined();
        const order = kv.get<string[]>('raven.dataViewer.sortOrder') ?? [];
        expect(order).toEqual([]);
    });

    test('clear on a missing key is a no-op (does not throw)', async () => {
        const kv = new MemKV();
        const store = new SortStateStore(kv as any, 10);
        await store.clear('nope', 'h');
        expect(await store.load('nope', 'h')).toBeUndefined();
    });
});
