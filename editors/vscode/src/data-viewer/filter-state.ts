/**
 * Persisted filter state for the data viewer. Mirrors {@link ./sort-state.ts}
 * and shares the same `maxStoredLayouts` LRU cap. Layout, toolbar, sort,
 * and filter persistence evict together for a given panel+hash.
 *
 * What's persisted is only the chip descriptors. The host always
 * recomputes the index on restore against the current reader — schema
 * hash equality is not evidence that two datasets share values.
 */

import type { Memento } from './layout-state';
import type { FilterState } from './messages';

const PREFIX = 'raven.dataViewer.filter::';
const ORDER_KEY = 'raven.dataViewer.filterOrder';

export class FilterStateStore {
    constructor(
        private readonly kv: Memento,
        private readonly cap: number,
    ) {}

    private compositeKey(panelName: string, hash: string): string {
        return `${PREFIX}${panelName}::${hash}`;
    }

    async load(panelName: string, hash: string): Promise<FilterState | undefined> {
        return this.kv.get<FilterState>(this.compositeKey(panelName, hash));
    }

    async save(panelName: string, hash: string, state: FilterState): Promise<void> {
        const key = this.compositeKey(panelName, hash);
        await this.kv.update(key, state);
        const order = (this.kv.get<string[]>(ORDER_KEY) ?? []).filter(k => k !== key);
        order.push(key);
        while (order.length > this.cap) {
            const evict = order.shift()!;
            await this.kv.update(evict, undefined);
        }
        await this.kv.update(ORDER_KEY, order);
    }

    async clear(panelName: string, hash: string): Promise<void> {
        const key = this.compositeKey(panelName, hash);
        await this.kv.update(key, undefined);
        const order = (this.kv.get<string[]>(ORDER_KEY) ?? []).filter(k => k !== key);
        await this.kv.update(ORDER_KEY, order);
    }
}
