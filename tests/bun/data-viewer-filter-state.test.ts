/**
 * FilterStateStore — persistence parity with SortStateStore.
 */
import { describe, test, expect } from 'bun:test';
import { FilterStateStore } from '../../editors/vscode/src/data-viewer/filter-state';
import type { FilterState } from '../../editors/vscode/src/data-viewer/messages';

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
    keys(): string[] { return [...this.m.keys()]; }
}

const STATE_A: FilterState = {
    entries: [{
        id: 'a',
        columnIndex: 0,
        predicate: { kind: 'numCompare', op: '>', value: 10 },
        enabled: true,
        includeMissing: false,
    }],
    labelsOnWhenFiltered: true,
};
const STATE_B: FilterState = {
    entries: [{
        id: 'b',
        columnIndex: 1,
        predicate: { kind: 'isEmpty' },
        enabled: false,
        includeMissing: false,
    }],
    labelsOnWhenFiltered: false,
};

describe('FilterStateStore', () => {
    test('save then load returns the stored state', async () => {
        const kv = new MemKV();
        const store = new FilterStateStore(kv as any, 10);
        await store.save('mtcars', 'abc', STATE_A);
        expect(await store.load('mtcars', 'abc')).toEqual(STATE_A);
    });
    test('load returns undefined when nothing saved', async () => {
        const store = new FilterStateStore(new MemKV() as any, 10);
        expect(await store.load('mtcars', 'abc')).toBeUndefined();
    });
    test('LRU eviction at cap', async () => {
        const kv = new MemKV();
        const store = new FilterStateStore(kv as any, 2);
        await store.save('a', 'h', STATE_A);
        await store.save('b', 'h', STATE_B);
        await store.save('c', 'h', STATE_A);
        expect(await store.load('a', 'h')).toBeUndefined();
        expect(await store.load('b', 'h')).toEqual(STATE_B);
        expect(await store.load('c', 'h')).toEqual(STATE_A);
    });
    test('clear removes the entry and its order slot', async () => {
        const kv = new MemKV();
        const store = new FilterStateStore(kv as any, 10);
        await store.save('a', 'h', STATE_A);
        await store.clear('a', 'h');
        expect(await store.load('a', 'h')).toBeUndefined();
    });
    test('different panel names with same hash do not collide', async () => {
        const store = new FilterStateStore(new MemKV() as any, 10);
        await store.save('a', 'h', STATE_A);
        await store.save('b', 'h', STATE_B);
        expect(await store.load('a', 'h')).toEqual(STATE_A);
        expect(await store.load('b', 'h')).toEqual(STATE_B);
    });
});
